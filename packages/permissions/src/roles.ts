/**
 * Code-defined roles on top of the fixed permission catalogue (USER-03,
 * USER-04, INST-06). `defineRoles` boot-fails a host's role config the
 * moment it references an unknown permission string, is missing the
 * reserved `superadmin` role, or narrows `superadmin` below
 * `ALL_PERMISSIONS` (D-10, D-11, D-12). Hosts compose roles by spreading
 * `defaultRoles` and overriding/adding keys (D-14) -- there is no
 * inheritance, `extends`, or wildcard: a role's permissions are exactly
 * what its list contains.
 */
import { ALL_PERMISSIONS, type Permission } from './catalogue.js';
import {
  DEPRECATED_PERMISSION_ALIASES,
  resolvePermissionName,
} from './deprecated.js';
import type { DeprecatedPermission } from './deprecated.js';

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
export type RoleConfig = Readonly<Record<string, RolePermissionList>> & {
  readonly superadmin: RolePermissionList;
};

/** The validated, normalized result of `defineRoles`/`validateRoleConfig`:
 * every role's permissions are deduped, catalogue-ordered `Permission`
 * strings (deprecated aliases already resolved to their canonical name). */
export type DefinedRoles<K extends string = string> = Readonly<
  Record<K, readonly Permission[]>
>;

/** Emitted once per deprecated permission string accepted into a role. */
export type DeprecatedPermissionEvent = {
  readonly roleKey: string;
  readonly alias: string;
  readonly permission: Permission;
};

export type DefineRolesOptions = {
  onDeprecatedPermission?: (event: DeprecatedPermissionEvent) => void;
};

export type RoleConfigIssueCode =
  | 'MISSING_SUPERADMIN'
  | 'SUPERADMIN_NOT_ALL_PERMISSIONS'
  | 'UNKNOWN_PERMISSION'
  | 'INVALID_ROLE_KEY'
  | 'INVALID_PERMISSION_LIST'
  | 'INVALID_ROLE_CONFIG';

export type RoleConfigIssue = {
  readonly code: RoleConfigIssueCode;
  readonly roleKey?: string;
  readonly value?: string;
  readonly message: string;
};

/** Thrown by `defineRoles`/`validateRoleConfig` with every problem found in
 * the config, collected before throwing once (never one-issue-at-a-time). */
export class RoleConfigError extends Error {
  readonly issues: readonly RoleConfigIssue[];

  constructor(issues: readonly RoleConfigIssue[]) {
    super(
      [
        '[@plakboek/permissions] invalid role config:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'RoleConfigError';
    this.issues = issues;
  }
}

/** A role key must be lowercase-kebab: starts with a letter, then letters,
 * digits or hyphens. Rejects case variants ("Editor"), whitespace
 * (" editor"), and inherited-property-name lookalikes ("__proto__",
 * "constructor", "toString") without any special-casing -- none of those
 * match the pattern. */
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

function defaultOnDeprecatedPermission(event: DeprecatedPermissionEvent): void {
  // oxlint-disable-next-line no-console -- this is the documented default fallback hook (D-09); a host overrides `onDeprecatedPermission` to route elsewhere
  console.warn(
    `[@plakboek/permissions] role "${event.roleKey}" uses deprecated permission "${event.alias}"; rename it to "${event.permission}"`,
  );
}

/** Narrows `unknown` to a plain, non-array object without an `as` cast. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows `unknown` to `string[]` without an `as` cast. */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * Module-level validator used directly by tests (not re-exported from
 * `index.ts`). `defineRoles` calls this with the shipped deprecated-alias
 * table; tests call it directly to inject a custom alias table.
 *
 * Collects every problem before throwing once. On success, every role's
 * permissions are deduped and reordered to catalogue declaration order
 * (`ALL_PERMISSIONS` filtered by membership), then frozen; the returned
 * container object is frozen too (T-01-20).
 */
export function validateRoleConfig(
  input: unknown,
  options?: DefineRolesOptions & {
    aliases?: Readonly<Record<string, Permission>>;
  },
): DefinedRoles {
  const issues: RoleConfigIssue[] = [];
  const aliases = options?.aliases ?? DEPRECATED_PERMISSION_ALIASES;
  const onDeprecatedPermission =
    options?.onDeprecatedPermission ?? defaultOnDeprecatedPermission;

  if (!isPlainObject(input)) {
    issues.push({
      code: 'INVALID_ROLE_CONFIG',
      message:
        'role config must be a plain object mapping role keys to permission lists',
    });
    throw new RoleConfigError(issues);
  }

  const roleKeys = Object.keys(input);
  const normalized = new Map<string, Permission[]>();

  for (const roleKey of roleKeys) {
    if (!ROLE_KEY_PATTERN.test(roleKey)) {
      issues.push({
        code: 'INVALID_ROLE_KEY',
        roleKey,
        message: `role key "${roleKey}" must match ${ROLE_KEY_PATTERN.source}`,
      });
      continue;
    }

    const rawList = input[roleKey];
    if (!isStringArray(rawList)) {
      issues.push({
        code: 'INVALID_PERMISSION_LIST',
        roleKey,
        message: `role "${roleKey}" must be an array of permission strings`,
      });
      continue;
    }

    const resolvedPermissions: Permission[] = [];
    for (const value of rawList) {
      const resolution = resolvePermissionName(value, aliases);
      if (resolution.kind === 'canonical') {
        resolvedPermissions.push(resolution.permission);
      } else if (resolution.kind === 'deprecated') {
        resolvedPermissions.push(resolution.permission);
        onDeprecatedPermission({
          roleKey,
          alias: resolution.alias,
          permission: resolution.permission,
        });
      } else {
        issues.push({
          code: 'UNKNOWN_PERMISSION',
          roleKey,
          value,
          message: `role "${roleKey}" references unknown permission "${value}"`,
        });
      }
    }
    normalized.set(roleKey, resolvedPermissions);
  }

  if (!Object.hasOwn(input, 'superadmin')) {
    issues.push({
      code: 'MISSING_SUPERADMIN',
      message:
        'role config must define a "superadmin" role holding ALL_PERMISSIONS',
    });
  } else {
    const superadminPermissions = normalized.get('superadmin');
    if (superadminPermissions !== undefined) {
      const superadminSet = new Set(superadminPermissions);
      const holdsAllPermissions =
        superadminSet.size === ALL_PERMISSIONS.length &&
        ALL_PERMISSIONS.every((permission) => superadminSet.has(permission));
      if (!holdsAllPermissions) {
        issues.push({
          code: 'SUPERADMIN_NOT_ALL_PERMISSIONS',
          roleKey: 'superadmin',
          message:
            'role "superadmin" must hold exactly ALL_PERMISSIONS -- use `superadmin: ALL_PERMISSIONS`',
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new RoleConfigError(issues);
  }

  const result: Record<string, readonly Permission[]> = {};
  for (const roleKey of roleKeys) {
    const resolved = normalized.get(roleKey);
    if (resolved === undefined) continue;
    const memberSet = new Set(resolved);
    result[roleKey] = Object.freeze(
      ALL_PERMISSIONS.filter((permission) => memberSet.has(permission)),
    );
  }

  return Object.freeze(result);
}

/**
 * Validate and normalize a host's role config. Throws a single
 * `RoleConfigError` listing every problem found; on success, returns a
 * frozen, deduped, catalogue-ordered permission map per role.
 */
export function defineRoles<const T extends RoleConfig>(
  roles: T,
  options?: DefineRolesOptions,
): DefinedRoles<Extract<keyof T, string>> {
  return validateRoleConfig(roles, options);
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
    'pages:read',
    'pages:read-drafts',
    'pages:create',
    'pages:edit',
    'pages:publish',
    'pages:delete',
    'entries:read',
    'entries:read-drafts',
    'entries:create',
    'entries:edit',
    'entries:publish',
    'entries:delete',
    'templates:edit',
    'templates:publish',
    'content-types:read',
    'content-types:create',
    'content-types:edit',
    'content-types:delete',
    'media:read',
    'media:upload',
    'media:edit',
    'media:delete',
    'menus:read',
    'menus:edit',
    'redirects:read',
    'redirects:manage',
    'users:read',
    'users:create',
    'users:edit',
    'users:deactivate',
    'users:assign-roles',
    'users:reset-password',
    'audit-log:read',
    'settings:read',
    'settings:manage',
    'api-tokens:create',
    'api-tokens:manage',
  ],
  // editor: edits and publishes content (22 permissions).
  editor: [
    'pages:read',
    'pages:read-drafts',
    'pages:create',
    'pages:edit',
    'pages:publish',
    'pages:delete',
    'entries:read',
    'entries:read-drafts',
    'entries:create',
    'entries:edit',
    'entries:publish',
    'entries:delete',
    'templates:edit',
    'templates:publish',
    'content-types:read',
    'media:read',
    'media:upload',
    'media:edit',
    'menus:read',
    'menus:edit',
    'redirects:read',
    'api-tokens:create',
  ],
} as const satisfies RoleConfig;

Object.freeze(defaultRoles.admin);
Object.freeze(defaultRoles.editor);
Object.freeze(defaultRoles);
