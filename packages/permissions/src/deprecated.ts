import { isPermission, type Permission } from "./catalogue.js";

/**
 * D-09 breaking-change policy for permission strings:
 *
 * - Adding a permission is a minor version bump.
 * - Renaming or removing a permission is a major version bump (while
 *   pre-1.0, per D-17, it is a minor bump instead) -- and the old name
 *   stays in this table, pointing at its replacement, for one major
 *   version after the rename/removal ships. Host configs that still
 *   reference the old name keep booting, with a warning (D-10); they are
 *   never rejected outright during that window.
 * - An alias key must never equal a canonical key in `PERMISSIONS`
 *   (catalogue.ts) -- a key that renames back onto itself is not a
 *   deprecation, it is a bug in this table.
 *
 * No permission has been renamed or removed since the v1 catalogue shipped
 * at 0.1.0, so this table starts empty. `DeprecatedPermission` (`keyof
 * typeof DEPRECATED_PERMISSION_ALIASES`) is therefore `never` today -- that
 * is intentional and still a literal type, not `string`: the first entry
 * added here narrows it to a real literal union, it never widens.
 */
export const DEPRECATED_PERMISSION_ALIASES = {} as const satisfies Record<string, Permission>;

Object.freeze(DEPRECATED_PERMISSION_ALIASES);

/** The union of every deprecated (renamed/removed) permission alias key. */
export type DeprecatedPermission = keyof typeof DEPRECATED_PERMISSION_ALIASES;

/** The result of classifying an arbitrary string against the catalogue and
 * the deprecated-alias table. */
export type PermissionNameResolution =
	| { readonly kind: "canonical"; readonly permission: Permission }
	| { readonly kind: "deprecated"; readonly alias: string; readonly permission: Permission }
	| { readonly kind: "unknown"; readonly value: string };

/**
 * Classify an arbitrary string as a canonical permission, a deprecated
 * alias (per `aliases`, defaulting to the shipped
 * `DEPRECATED_PERMISSION_ALIASES`), or unknown.
 *
 * Checks `isPermission` first so a canonical name is never misclassified
 * as deprecated even if it were accidentally also present as an alias key.
 * Alias lookup uses `Object.hasOwn` (not `in` or bracket access), so
 * inherited `Object.prototype` keys (`__proto__`, `constructor`, ...) are
 * always classified as unknown, never as a hit (T-01-08).
 */
export function resolvePermissionName(
	value: string,
	aliases: Readonly<Record<string, Permission>> = DEPRECATED_PERMISSION_ALIASES,
): PermissionNameResolution {
	if (isPermission(value)) {
		return { kind: "canonical", permission: value };
	}
	if (Object.hasOwn(aliases, value)) {
		// `noUncheckedIndexedAccess` still types this access as
		// `Permission | undefined` despite the `hasOwn` guard above -- the
		// explicit check keeps the narrowing sound without an unsafe assertion.
		const permission = aliases[value];
		if (permission !== undefined) {
			return { kind: "deprecated", alias: value, permission };
		}
	}
	return { kind: "unknown", value };
}
