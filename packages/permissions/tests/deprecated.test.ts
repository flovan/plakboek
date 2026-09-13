import { describe, expect, expectTypeOf, it } from "vitest";
import { isPermission } from "../src/catalogue.js";
import {
	DEPRECATED_PERMISSION_ALIASES,
	resolvePermissionName,
	type DeprecatedPermission,
} from "../src/deprecated.js";

describe("resolvePermissionName", () => {
	it("classifies a canonical permission string", () => {
		expect(resolvePermissionName("pages:edit")).toStrictEqual({
			kind: "canonical",
			permission: "pages:edit",
		});
	});

	it("classifies a deprecated alias against an injected table", () => {
		const table = { "pages:update": "pages:edit" } as const;
		expect(resolvePermissionName("pages:update", table)).toStrictEqual({
			kind: "deprecated",
			alias: "pages:update",
			permission: "pages:edit",
		});
	});

	it.each(["pages:own-edit", "__proto__", "constructor"])(
		"classifies %s as unknown",
		(value) => {
			expect(resolvePermissionName(value)).toStrictEqual({ kind: "unknown", value });
		},
	);
});

describe("DEPRECATED_PERMISSION_ALIASES", () => {
	it("is frozen", () => {
		expect(Object.isFrozen(DEPRECATED_PERMISSION_ALIASES)).toBe(true);
	});

	it("every alias target satisfies isPermission and no alias key is itself canonical", () => {
		for (const [alias, target] of Object.entries(DEPRECATED_PERMISSION_ALIASES)) {
			expect(isPermission(target)).toBe(true);
			expect(isPermission(alias)).toBe(false);
		}
	});
});

describe("DeprecatedPermission type", () => {
	it("is a literal union, not widened to string (compile-time assertion)", () => {
		// A type-level assertion: if DeprecatedPermission were ever widened to
		// `string` (e.g. by typing DEPRECATED_PERMISSION_ALIASES as a plain
		// Record instead of `as const satisfies Record<string, Permission>`),
		// this line fails `tsc --noEmit`, not just this runtime no-op.
		expectTypeOf<DeprecatedPermission>().not.toEqualTypeOf<string>();
	});
});
