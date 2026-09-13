import type { Permission } from "./catalogue.js";

/**
 * RED-phase scaffold only: enough shape for tests/deprecated.test.ts to
 * import without a module-resolution crash. The real classification logic
 * is implemented in the GREEN commit that follows.
 */
export const DEPRECATED_PERMISSION_ALIASES = {} as const satisfies Record<string, Permission>;

export type DeprecatedPermission = keyof typeof DEPRECATED_PERMISSION_ALIASES;

export type PermissionNameResolution =
	| { readonly kind: "canonical"; readonly permission: Permission }
	| { readonly kind: "deprecated"; readonly alias: string; readonly permission: Permission }
	| { readonly kind: "unknown"; readonly value: string };

export function resolvePermissionName(
	_value: string,
	_aliases: Readonly<Record<string, Permission>> = DEPRECATED_PERMISSION_ALIASES,
): PermissionNameResolution {
	throw new Error("resolvePermissionName: not implemented yet");
}
