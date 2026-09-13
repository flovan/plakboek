/**
 * Orphaned-role-safe permission resolver (USER-10, D-15). A user's stored
 * `role_key` (Phase 2) may no longer exist in the host's code role map --
 * the role definition changed, or the key was mistyped upstream. `resolve`
 * must never throw for that case: an unknown role key is denied every
 * permission and surfaced once, rate-limited per key, through an
 * injectable hook that can never crash the permission check itself
 * (T-01-16, T-01-18).
 */
import type { Permission } from "./catalogue.js";
import type { DefinedRoles } from "./roles.js";

/** Emitted when `resolve` is asked for a role key absent from the code role
 * map. Carries only the role key, the opaque user id (when known), when it
 * happened, and how many prior lookups for this same key were suppressed
 * by the rate limit -- never anything else about the user (T-01-23). */
export interface OrphanedRoleEvent {
	readonly roleKey: string;
	readonly userId?: string;
	readonly occurredAt: Date;
	readonly suppressedCount: number;
}

export type OrphanedRoleHook = (event: OrphanedRoleEvent) => void;

export interface PermissionResolverOptions {
	onOrphanedRole?: OrphanedRoleHook;
	rateLimitMs?: number;
	now?: () => number;
}

export interface PermissionResolver {
	resolve(roleKey: string, context?: { userId?: string }): ReadonlySet<Permission>;
	isKnownRole(roleKey: string): boolean;
}

const DEFAULT_RATE_LIMIT_MS = 60_000;

/** Cap on distinct orphaned role keys tracked for rate limiting (T-01-22) --
 * without it, an attacker (or a persistently misconfigured client) sending
 * arbitrarily many distinct bogus role keys could grow this state without
 * bound. The oldest-inserted key is evicted to make room for a new one. */
const MAX_TRACKED_KEYS = 1000;

function defaultOnOrphanedRole(event: OrphanedRoleEvent): void {
	const userPart = event.userId !== undefined ? ` (user ${event.userId})` : "";
	console.warn(
		`[@plakboek/permissions] orphaned role key "${event.roleKey}"${userPart} -- denying all permissions`,
	);
}

interface OrphanKeyState {
	lastEmittedAt: number;
	suppressed: number;
}

/**
 * Build a resolver over a validated role map (the output of `defineRoles`).
 * `resolve` never throws: an unknown role key returns an empty set and
 * reports the orphan through `onOrphanedRole` (default `console.warn`),
 * rate-limited independently per key.
 */
export function createPermissionResolver(
	roles: DefinedRoles,
	options?: PermissionResolverOptions,
): PermissionResolver {
	// Snapshotted into a Map at creation: Map.has/get never consult the
	// prototype chain, so "__proto__"/"constructor"/"toString" role keys are
	// always treated as absent, never as an inherited Object.prototype member
	// (T-01-17).
	const roleMap = new Map<string, readonly Permission[]>(Object.entries(roles));
	const rateLimitMs = options?.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
	const now = options?.now ?? Date.now;
	const hook = options?.onOrphanedRole ?? defaultOnOrphanedRole;
	const orphanState = new Map<string, OrphanKeyState>();

	function isKnownRole(roleKey: string): boolean {
		return roleMap.has(roleKey);
	}

	function emitOrphanedRoleEvent(roleKey: string, userId: string | undefined): void {
		const nowMs = now();
		const state = orphanState.get(roleKey);

		if (state !== undefined && nowMs - state.lastEmittedAt < rateLimitMs) {
			state.suppressed += 1;
			return;
		}

		const suppressedCount = state?.suppressed ?? 0;

		if (state === undefined && orphanState.size >= MAX_TRACKED_KEYS) {
			const oldestKey = orphanState.keys().next().value;
			if (oldestKey !== undefined) {
				orphanState.delete(oldestKey);
			}
		}
		orphanState.set(roleKey, { lastEmittedAt: nowMs, suppressed: 0 });

		const event: OrphanedRoleEvent = {
			roleKey,
			...(userId !== undefined ? { userId } : {}),
			occurredAt: new Date(nowMs),
			suppressedCount,
		};

		// A broken/slow host-supplied hook must never turn a permission check
		// into an unhandled exception (T-01-18) -- the decision itself (an
		// empty Set) is already made before this function runs.
		try {
			hook(event);
		} catch (error) {
			try {
				console.error(
					`[@plakboek/permissions] onOrphanedRole hook threw while handling role "${roleKey}"`,
					error,
				);
			} catch {
				// Never let a broken console/logger escape either.
			}
		}
	}

	function resolve(roleKeyInput: string, context?: { userId?: string }): ReadonlySet<Permission> {
		// `String()` is a no-op for the declared `string` type but a real
		// defensive coercion for a caller that bypassed TypeScript (a plain-JS
		// consumer, or an `as never` escape hatch) and passed e.g. `null`/`42`
		// -- resolve() must still behave sanely (deny + report) rather than
		// crash on a bad Map lookup key.
		// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- see comment above
		const roleKey = String(roleKeyInput);
		const known = roleMap.get(roleKey);
		if (known !== undefined) {
			return new Set(known);
		}

		emitOrphanedRoleEvent(roleKey, context?.userId);
		return new Set();
	}

	return { resolve, isKnownRole };
}
