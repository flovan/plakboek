import { ALL_PERMISSIONS, isPermission, PERMISSIONS, type Permission } from "@plakboek/permissions";

const permission: Permission = "pages:publish";

// @ts-expect-error -- "pages:own-edit" is not a valid Permission
const invalidPermission: Permission = "pages:own-edit";

console.log(
	permission,
	invalidPermission,
	isPermission(permission),
	PERMISSIONS[permission].group,
	ALL_PERMISSIONS.length,
);
