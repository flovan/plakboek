import {
  ALL_PERMISSIONS,
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  isPermission,
  PERMISSIONS,
  type DefinedRoles,
  type OrphanedRoleEvent,
  type Permission,
} from '@plakboek/permissions';

if (
  !Array.isArray(ALL_PERMISSIONS) ||
  ALL_PERMISSIONS.length === 0 ||
  !Object.isFrozen(ALL_PERMISSIONS)
) {
  process.exit(1);
}

const permission: Permission = 'pages:publish';

// @ts-expect-error -- "pages:own-edit" is not a valid Permission
const invalidPermission: Permission = 'pages:own-edit';

console.log(
  'permissions.ts: ALL_PERMISSIONS is a non-empty frozen array',
  permission,
  invalidPermission,
  isPermission(permission),
  PERMISSIONS[permission].group,
  ALL_PERMISSIONS.length,
);

const roles: DefinedRoles<'superadmin' | 'admin' | 'editor' | 'client'> =
  defineRoles({
    ...defaultRoles,
    client: ['pages:read', 'pages:edit'],
  });

/** Type-only negative check: `defineRoles` really does throw at runtime for
 * an unknown permission string (proven by permissions/tests/roles.test.ts),
 * so this body is never called here -- only type-checked, exercising the
 * `@ts-expect-error` below against the packed types. Exported (never
 * imported anywhere) so it counts as used rather than dead code. */
export function rejectsUnknownPermissionAtTypeLevel(): void {
  // @ts-expect-error -- "totally:unknown" is not a valid Permission or DeprecatedPermission
  defineRoles({ ...defaultRoles, broken: ['totally:unknown'] });
}

const resolver = createPermissionResolver(roles, {
  onOrphanedRole(event: OrphanedRoleEvent) {
    console.log(event.roleKey, event.occurredAt, event.suppressedCount);
  },
});
const clientPermissions = resolver.resolve('client');

console.log(clientPermissions.size);

if (resolver.resolve('ghost').size !== 0) {
  process.exit(1);
}

console.log(
  'permissions.ts: defineRoles(defaultRoles) succeeds and an orphaned role key resolves to an empty set',
);
