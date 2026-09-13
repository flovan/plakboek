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

/**
 * Build a resolver over a validated role map (the output of `defineRoles`).
 * `resolve` never throws: an unknown role key returns an empty set and
 * reports the orphan through `onOrphanedRole` (default `console.warn`),
 * rate-limited independently per key.
 */
export function createPermissionResolver(
	_roles: DefinedRoles,
	_options?: PermissionResolverOptions,
): PermissionResolver {
	throw new Error("createPermissionResolver: not implemented");
}
