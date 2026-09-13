import { describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS } from "../src/catalogue.js";
import { defaultRoles, defineRoles, RoleConfigError, validateRoleConfig } from "../src/roles.js";

/** Narrows `unknown` to a plain-object record without an `as` assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Runs `run`, asserts it throws a `RoleConfigError`, and returns it for
 * `.issues` inspection. Fails the test loudly if `run` doesn't throw one. */
function captureRoleConfigError(run: () => unknown): RoleConfigError {
	try {
		run();
	} catch (error) {
		if (error instanceof RoleConfigError) return error;
		throw error;
	}
	throw new Error("expected the callback to throw a RoleConfigError");
}

/** Lexicographic sort via `toSorted` (never mutates) with an explicit
 * comparator (required by oxlint's `require-array-sort-compare`). */
function sortedStrings(values: readonly string[]): string[] {
	return values.toSorted((a, b) => a.localeCompare(b));
}

const SUPERADMIN_ONLY_PERMISSIONS = [
	"pages:delete-permanent",
	"entries:delete-permanent",
	"users:impersonate",
	"modules:manage",
	"blocks:manage",
	"bootstrap:run",
	"backups:manage",
	"backups:restore",
] as const;

describe("defineRoles(defaultRoles)", () => {
	it("succeeds with no customisation and yields exactly superadmin, admin, editor", () => {
		const roles = defineRoles(defaultRoles);
		expect(sortedStrings(Object.keys(roles))).toStrictEqual(["admin", "editor", "superadmin"]);
		expect(roles.superadmin).toStrictEqual(ALL_PERMISSIONS);
	});

	it("admin and editor contain none of the 8 superadmin-only permissions (D-13)", () => {
		const roles = defineRoles(defaultRoles);
		for (const permission of SUPERADMIN_ONLY_PERMISSIONS) {
			expect(roles.admin).not.toContain(permission);
			expect(roles.editor).not.toContain(permission);
		}
	});
});

describe("role composition (D-14)", () => {
	it("adds a new role via spread + override with exactly the listed permissions, no :publish permission", () => {
		const roles = defineRoles({ ...defaultRoles, client: ["pages:read", "pages:edit"] });
		expect(roles.client).toStrictEqual(["pages:read", "pages:edit"]);
		expect(roles.client).not.toContain("pages:publish");
	});

	it("redefining an existing role key via spread replaces its list entirely, no merge", () => {
		const roles = defineRoles({ ...defaultRoles, editor: ["pages:read"] });
		expect(roles.editor).toStrictEqual(["pages:read"]);
	});

	it("keeps a role explicitly listed as an empty array", () => {
		const roles = defineRoles({ ...defaultRoles, guest: [] });
		expect(roles.guest).toStrictEqual([]);
	});
});

describe("permission list normalization", () => {
	it("dedupes duplicate entries in a role list", () => {
		const roles = defineRoles({
			...defaultRoles,
			editor: ["pages:edit", "pages:read", "pages:edit"],
		});
		expect(roles.editor).toStrictEqual(["pages:read", "pages:edit"]);
	});

	it("normalizes to catalogue order regardless of input order", () => {
		const forward = defineRoles({ ...defaultRoles, editor: ["pages:read", "pages:edit"] });
		const backward = defineRoles({ ...defaultRoles, editor: ["pages:edit", "pages:read"] });
		expect(forward.editor).toStrictEqual(["pages:read", "pages:edit"]);
		expect(backward.editor).toStrictEqual(["pages:read", "pages:edit"]);
	});
});

describe("MISSING_SUPERADMIN", () => {
	it("validateRoleConfig({}) throws RoleConfigError with a MISSING_SUPERADMIN issue", () => {
		const error = captureRoleConfigError(() => validateRoleConfig({}));
		expect(error.issues.some((issue) => issue.code === "MISSING_SUPERADMIN")).toBe(true);
	});

	it("defineRoles({}) throws (type-level: RoleConfig requires a superadmin key)", () => {
		const error = captureRoleConfigError(() => {
			// @ts-expect-error -- RoleConfig requires a "superadmin" key
			return defineRoles({});
		});
		expect(error.issues.some((issue) => issue.code === "MISSING_SUPERADMIN")).toBe(true);
	});
});

describe("SUPERADMIN_NOT_ALL_PERMISSIONS", () => {
	it("throws when superadmin does not hold exactly ALL_PERMISSIONS", () => {
		const error = captureRoleConfigError(() => validateRoleConfig({ superadmin: ["pages:read"] }));
		expect(
			error.issues.some(
				(issue) =>
					issue.code === "SUPERADMIN_NOT_ALL_PERMISSIONS" && issue.roleKey === "superadmin",
			),
		).toBe(true);
	});

	it("accepts ALL_PERMISSIONS in any order", () => {
		const reversed = ALL_PERMISSIONS.toReversed();
		const roles = validateRoleConfig({ superadmin: reversed });
		expect(roles.superadmin).toStrictEqual(ALL_PERMISSIONS);
	});
});

describe("UNKNOWN_PERMISSION", () => {
	it("collects one issue per unknown permission string, across roles, in a single error", () => {
		// `as never` intentionally bypasses the type system -- this exercises
		// the runtime UNKNOWN_PERMISSION check for values that got past
		// TypeScript (e.g. a plain-JS host config, or an `as any`/`as never`
		// escape hatch), not something the type checker should catch here.
		const error = captureRoleConfigError(() =>
			defineRoles({
				...defaultRoles,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional bypass, see comment above
				client: ["pages:read", "totally:unknown" as never],
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional bypass, see comment above
				writer: ["another:unknown" as never],
			}),
		);
		const unknownIssues = error.issues.filter((issue) => issue.code === "UNKNOWN_PERMISSION");
		expect(unknownIssues).toHaveLength(2);
		expect(unknownIssues).toContainEqual(
			expect.objectContaining({ roleKey: "client", value: "totally:unknown" }),
		);
		expect(unknownIssues).toContainEqual(
			expect.objectContaining({ roleKey: "writer", value: "another:unknown" }),
		);
	});
});

describe("INVALID_ROLE_KEY", () => {
	it("rejects 'Editor', ' editor', and an own '__proto__' property created via JSON.parse", () => {
		const raw: unknown = JSON.parse(
			`{"superadmin": ${JSON.stringify([...ALL_PERMISSIONS])}, "Editor": ["pages:read"], " editor": ["pages:read"], "__proto__": ["pages:read"]}`,
		);
		// Sanity check the fixture actually produced an own "__proto__" property
		// (an object *literal* with a `__proto__` key sets the prototype
		// instead -- JSON.parse does not).
		expect(isRecord(raw) && Object.hasOwn(raw, "__proto__")).toBe(true);

		const error = captureRoleConfigError(() => validateRoleConfig(raw));
		const invalidKeys = sortedStrings(
			error.issues
				.filter((issue) => issue.code === "INVALID_ROLE_KEY")
				.map((issue) => issue.roleKey ?? ""),
		);
		expect(invalidKeys).toStrictEqual(sortedStrings(["Editor", "__proto__", " editor"]));
	});
});

describe("validateRoleConfig deprecated aliases (D-09, D-10)", () => {
	it("accepts a deprecated alias via an injected table, normalizes it, and calls onDeprecatedPermission once", () => {
		const events: unknown[] = [];
		const result = validateRoleConfig(
			{ superadmin: ALL_PERMISSIONS, editor: ["pages:update"] },
			{
				aliases: { "pages:update": "pages:edit" },
				onDeprecatedPermission: (event) => events.push(event),
			},
		);
		expect(result.editor).toStrictEqual(["pages:edit"]);
		expect(events).toStrictEqual([
			{ roleKey: "editor", alias: "pages:update", permission: "pages:edit" },
		]);
	});

	it("calls console.warn by default when no onDeprecatedPermission option is given", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			validateRoleConfig(
				{ superadmin: ALL_PERMISSIONS, editor: ["pages:update"] },
				{ aliases: { "pages:update": "pages:edit" } },
			);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toContain("pages:update");
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("immutability", () => {
	it("throws TypeError when pushing onto a returned role array", () => {
		const roles = defineRoles(defaultRoles);
		expect(() => {
			// @ts-expect-error -- intentionally violating the readonly role array
			roles.editor.push("pages:read");
		}).toThrow(TypeError);
	});

	it("throws TypeError when assigning a new role key on the returned object", () => {
		const roles = defineRoles(defaultRoles);
		expect(() => {
			// @ts-expect-error -- intentionally violating the readonly container
			roles.client = ["pages:read"];
		}).toThrow(TypeError);
	});
});

describe("type level", () => {
	it("compiles with @ts-expect-error and still throws at runtime for a missing superadmin key", () => {
		expect(() => {
			// @ts-expect-error -- RoleConfig requires a "superadmin" key
			defineRoles({ editor: ["pages:read"] });
		}).toThrow();
	});

	it("compiles with @ts-expect-error and still throws at runtime for an unknown permission string", () => {
		expect(() => {
			// @ts-expect-error -- "pages:own-edit" is not a valid Permission or DeprecatedPermission
			defineRoles({ superadmin: ALL_PERMISSIONS, editor: ["pages:own-edit"] });
		}).toThrow();
	});
});
