/**
 * Code-defined roles on top of the fixed permission catalogue (USER-03,
 * USER-04, INST-06). `defineRoles` boot-fails a host's role config the
 * moment it references an unknown permission string, is missing the
 * reserved `superadmin` role, or narrows `superadmin` below
 * `ALL_PERMISSIONS` (D-10, D-11, D-12). Hosts compose roles by spreading
 * `defaultRoles` and overriding/adding keys (D-14) -- there is no
 * inheritance, `extends`, or wildcard: a role's permissions are exactly
 * what its list contains.
 *
 * RED-phase stub: every exported type is in its final shape so
 * `tests/roles.test.ts` resolves and each test fails on its own assertion
 * or thrown error, never on a module-load crash. `defaultRoles` is plain
 * data (not "behavior"), so it already carries its real content here;
 * `validateRoleConfig`/`defineRoles` throw until the GREEN commit.
 */
import { ALL_PERMISSIONS, type Permission } from "./catalogue.js";
import type { DeprecatedPermission } from "./deprecated.js";

/** A single role's permission list, as a host writes it: canonical
 * `Permission` strings, or a still-accepted deprecated alias (D-09).
 * `DeprecatedPermission` is `never` at 0.1.0 (no permission has been
 * renamed/removed yet, see deprecated.ts) -- the union is written this way
 * deliberately so it widens automatically the day the alias table gets its
 * first real entry, without this type needing to change. */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- see comment above; DeprecatedPermission is intentionally never today
export type RolePermissionList = readonly (Permission | DeprecatedPermission)[];

/**
 * The shape a host passes to `defineRoles`. `superadmin` is a required,
 * reserved key (D-12); any other lowercase-kebab role key maps to its own
 * permission list.
 */
export type RoleConfig = {
	readonly superadmin: RolePermissionList;
	readonly [roleKey: string]: RolePermissionList;
};

/** The validated, normalized result of `defineRoles`/`validateRoleConfig`:
 * every role's permissions are deduped, catalogue-ordered `Permission`
 * strings (deprecated aliases already resolved to their canonical name). */
export type DefinedRoles<K extends string = string> = {
	readonly [P in K]: readonly Permission[];
};

/** Emitted once per deprecated permission string accepted into a role. */
export interface DeprecatedPermissionEvent {
	readonly roleKey: string;
	readonly alias: string;
	readonly permission: Permission;
}

export interface DefineRolesOptions {
	onDeprecatedPermission?: (event: DeprecatedPermissionEvent) => void;
}

export type RoleConfigIssueCode =
	| "MISSING_SUPERADMIN"
	| "SUPERADMIN_NOT_ALL_PERMISSIONS"
	| "UNKNOWN_PERMISSION"
	| "INVALID_ROLE_KEY"
	| "INVALID_PERMISSION_LIST"
	| "INVALID_ROLE_CONFIG";

export interface RoleConfigIssue {
	readonly code: RoleConfigIssueCode;
	readonly roleKey?: string;
	readonly value?: string;
	readonly message: string;
}

/** Thrown by `defineRoles`/`validateRoleConfig` with every problem found in
 * the config, collected before throwing once (never one-issue-at-a-time). */
export class RoleConfigError extends Error {
	readonly issues: readonly RoleConfigIssue[];

	constructor(issues: readonly RoleConfigIssue[]) {
		super("[@plakboek/permissions] invalid role config: not implemented");
		this.name = "RoleConfigError";
		this.issues = issues;
	}
}

/**
 * Module-level validator used directly by tests (not re-exported from
 * `index.ts`). `defineRoles` calls this with the shipped deprecated-alias
 * table; tests call it directly to inject a custom alias table.
 */
export function validateRoleConfig(
	_input: unknown,
	_options?: DefineRolesOptions & { aliases?: Readonly<Record<string, Permission>> },
): DefinedRoles {
	throw new Error("validateRoleConfig: not implemented");
}

/**
 * Validate and normalize a host's role config. Throws a single
 * `RoleConfigError` listing every problem found; on success, returns a
 * frozen, deduped, catalogue-ordered permission map per role.
 */
export function defineRoles<const T extends RoleConfig>(
	_roles: T,
	_options?: DefineRolesOptions,
): DefinedRoles<Extract<keyof T, string>> {
	throw new Error("defineRoles: not implemented");
}

// Superadmin-only permissions (the 8 not held by the shipped `admin` role):
// users:impersonate (acting as someone else is a materially higher
// privilege than editing their profile), modules:manage and blocks:manage
// (installation shape/toggle decisions, not day-to-day site operation),
// bootstrap:run (one-time/destructive setup), backups:manage/backups:restore
// (operational infrastructure, restore is a full rollback of live data),
// pages:delete-permanent/entries:delete-permanent (irrecoverable purge, kept
// out of "runs the site and users" per D-13's own framing).
/**
 * The shipped `superadmin`/`admin`/`editor` role set (D-13). Works with
 * zero customisation (USER-04); hosts compose via
 * `defineRoles({ ...defaultRoles, client: [...] })` (D-14).
 */
export const defaultRoles = {
	superadmin: ALL_PERMISSIONS,
	// admin: runs the site and its users, but is not superadmin (37 permissions).
	admin: [
		"pages:read",
		"pages:read-drafts",
		"pages:create",
		"pages:edit",
		"pages:publish",
		"pages:delete",
		"entries:read",
		"entries:read-drafts",
		"entries:create",
		"entries:edit",
		"entries:publish",
		"entries:delete",
		"templates:edit",
		"templates:publish",
		"content-types:read",
		"content-types:create",
		"content-types:edit",
		"content-types:delete",
		"media:read",
		"media:upload",
		"media:edit",
		"media:delete",
		"menus:read",
		"menus:edit",
		"redirects:read",
		"redirects:manage",
		"users:read",
		"users:create",
		"users:edit",
		"users:deactivate",
		"users:assign-roles",
		"users:reset-password",
		"audit-log:read",
		"settings:read",
		"settings:manage",
		"api-tokens:create",
		"api-tokens:manage",
	],
	// editor: edits and publishes content (22 permissions).
	editor: [
		"pages:read",
		"pages:read-drafts",
		"pages:create",
		"pages:edit",
		"pages:publish",
		"pages:delete",
		"entries:read",
		"entries:read-drafts",
		"entries:create",
		"entries:edit",
		"entries:publish",
		"entries:delete",
		"templates:edit",
		"templates:publish",
		"content-types:read",
		"media:read",
		"media:upload",
		"media:edit",
		"menus:read",
		"menus:edit",
		"redirects:read",
		"api-tokens:create",
	],
} as const satisfies RoleConfig;

Object.freeze(defaultRoles.admin);
Object.freeze(defaultRoles.editor);
Object.freeze(defaultRoles);
