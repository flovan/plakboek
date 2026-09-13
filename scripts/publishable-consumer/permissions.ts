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

const permission: Permission = 'pages:publish';

// @ts-expect-error -- "pages:own-edit" is not a valid Permission
const invalidPermission: Permission = 'pages:own-edit';

console.log(
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

// @ts-expect-error -- "totally:unknown" is not a valid Permission or DeprecatedPermission
defineRoles({ ...defaultRoles, broken: ['totally:unknown'] });

const resolver = createPermissionResolver(roles, {
  onOrphanedRole(event: OrphanedRoleEvent) {
    console.log(event.roleKey, event.occurredAt, event.suppressedCount);
  },
});
const clientPermissions = resolver.resolve('client');

console.log(clientPermissions.size);
