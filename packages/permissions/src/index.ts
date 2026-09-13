export type {
  PermissionMessage,
  PermissionMeta,
  PermissionGroup,
  Permission,
} from './catalogue.js';
export {
  PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  isPermission,
} from './catalogue.js';
export type {
  DeprecatedPermission,
  PermissionNameResolution,
} from './deprecated.js';
export {
  DEPRECATED_PERMISSION_ALIASES,
  resolvePermissionName,
} from './deprecated.js';
export type {
  RoleConfig,
  RolePermissionList,
  DefinedRoles,
  DefineRolesOptions,
  DeprecatedPermissionEvent,
  RoleConfigIssue,
  RoleConfigIssueCode,
} from './roles.js';
export { defineRoles, defaultRoles, RoleConfigError } from './roles.js';
export type {
  OrphanedRoleEvent,
  OrphanedRoleHook,
  PermissionResolver,
  PermissionResolverOptions,
} from './resolve.js';
export { createPermissionResolver } from './resolve.js';
