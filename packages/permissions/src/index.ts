export type {
	PermissionMessage,
	PermissionMeta,
	PermissionGroup,
	Permission,
} from "./catalogue.js";
export { PERMISSIONS, ALL_PERMISSIONS, PERMISSION_GROUPS, isPermission } from "./catalogue.js";
export type { DeprecatedPermission, PermissionNameResolution } from "./deprecated.js";
export { DEPRECATED_PERMISSION_ALIASES, resolvePermissionName } from "./deprecated.js";
