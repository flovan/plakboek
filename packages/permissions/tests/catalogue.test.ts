import { describe, expect, it } from "vitest";
import * as catalogue from "../src/catalogue.js";

/**
 * Namespace import (not named imports) is deliberate: `PERMISSION_GROUPS`
 * does not exist on the tracer catalogue this test starts against, and a
 * named import of a non-existent binding is a module-load error, not a
 * targeted assertion failure. Property access on the namespace object stays
 * `undefined` instead, so each behavior fails on its own assertion.
 */

const EXPECTED_PERMISSIONS = [
	"pages:read",
	"pages:read-drafts",
	"pages:create",
	"pages:edit",
	"pages:publish",
	"pages:delete",
	"pages:delete-permanent",
	"entries:read",
	"entries:read-drafts",
	"entries:create",
	"entries:edit",
	"entries:publish",
	"entries:delete",
	"entries:delete-permanent",
	"templates:edit",
	"templates:publish",
	"content-types:read",
	"content-types:create",
	"content-types:edit",
	"content-types:delete",
	"media:read",
	"media:upload",
	"media:edit",
	"media:delete",
	"menus:read",
	"menus:edit",
	"redirects:read",
	"redirects:manage",
	"users:read",
	"users:create",
	"users:edit",
	"users:deactivate",
	"users:assign-roles",
	"users:reset-password",
	"users:impersonate",
	"audit-log:read",
	"settings:read",
	"settings:manage",
	"modules:manage",
	"blocks:manage",
	"bootstrap:run",
	"api-tokens:create",
	"api-tokens:manage",
	"backups:manage",
	"backups:restore",
] as const;

const EXPECTED_GROUPS = [
	"pages",
	"entries",
	"templates",
	"content-types",
	"media",
	"menus",
	"seo",
	"users",
	"audit",
	"settings",
	"api",
	"backups",
] as const;

const PERMISSION_KEY_PATTERN = /^[a-z]+(-[a-z]+)*:[a-z]+(-[a-z]+)*$/;
const LABEL_ID_PATTERN = /^permissions\.[a-zA-Z]+\.[a-zA-Z]+\.label$/;

describe("ALL_PERMISSIONS", () => {
	it("contains all 45 catalogue-spec permissions in spec declaration order", () => {
		expect(catalogue.ALL_PERMISSIONS).toStrictEqual(EXPECTED_PERMISSIONS);
	});
});

describe("PERMISSION_GROUPS", () => {
	it("equals the 12 catalogue-spec groups in table order", () => {
		expect(catalogue.PERMISSION_GROUPS).toStrictEqual(EXPECTED_GROUPS);
	});

	it("has at least one permission per group, and every permission's group is listed", () => {
		const groupsInUse = new Set(Object.values(catalogue.PERMISSIONS).map((meta) => meta.group));
		for (const group of EXPECTED_GROUPS) {
			expect(groupsInUse.has(group)).toBe(true);
		}
		for (const meta of Object.values(catalogue.PERMISSIONS)) {
			expect(EXPECTED_GROUPS).toContain(meta.group);
		}
	});
});

describe("permission key format (D-05)", () => {
	it("every key is kebab-case resource:action with no own/any ownership segment", () => {
		const keys = Object.keys(catalogue.PERMISSIONS);
		expect(keys.length).toBe(45);
		for (const key of keys) {
			expect(key).toMatch(PERMISSION_KEY_PATTERN);
			for (const segment of key.split(/[:-]/)) {
				expect(segment).not.toBe("own");
				expect(segment).not.toBe("any");
			}
		}
	});
});

describe("edit/publish separation (D-06)", () => {
	it.each(["pages", "entries", "templates"] as const)(
		"%s has distinct :edit and :publish permissions",
		(resource) => {
			expect(Object.hasOwn(catalogue.PERMISSIONS, `${resource}:edit`)).toBe(true);
			expect(Object.hasOwn(catalogue.PERMISSIONS, `${resource}:publish`)).toBe(true);
		},
	);
});

describe("descriptor metadata (D-08)", () => {
	it("every label/description id follows the permissions.<resource>.<action>.<kind> shape, unique, non-empty, single-line", () => {
		const entries = Object.entries(catalogue.PERMISSIONS);
		expect(entries.length).toBe(45);

		const seenIds = new Set<string>();
		for (const [, meta] of entries) {
			expect(meta.label.id).toMatch(LABEL_ID_PATTERN);
			expect(meta.description.id).toBe(`${meta.label.id.slice(0, -".label".length)}.description`);

			for (const id of [meta.label.id, meta.description.id]) {
				expect(seenIds.has(id)).toBe(false);
				seenIds.add(id);
			}

			for (const message of [meta.label.message, meta.description.message]) {
				expect(typeof message).toBe("string");
				expect(message.length).toBeGreaterThan(0);
				expect(message).not.toMatch(/\n/);
			}
		}
	});
});

describe("catalogue immutability", () => {
	it("throws when assigning a new key on PERMISSIONS", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the readonly catalogue shape
			catalogue.PERMISSIONS["pages:own-edit"] = catalogue.PERMISSIONS["pages:edit"];
		}).toThrow(TypeError);
	});

	it("throws when replacing a catalogue entry's metadata object", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the frozen metadata shape
			catalogue.PERMISSIONS["pages:edit"].group = "entries";
		}).toThrow(TypeError);
	});

	it("throws when replacing a catalogue entry's label object", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the frozen label shape
			catalogue.PERMISSIONS["pages:edit"].label.message = "x";
		}).toThrow(TypeError);
	});

	it("throws when pushing onto ALL_PERMISSIONS", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the frozen array
			catalogue.ALL_PERMISSIONS.push("pages:read");
		}).toThrow(TypeError);
	});

	it("throws when pushing onto PERMISSION_GROUPS", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the frozen array
			catalogue.PERMISSION_GROUPS.push("pages");
		}).toThrow(TypeError);
	});
});

describe("isPermission", () => {
	it("returns true for a known permission string", () => {
		expect(catalogue.isPermission("pages:edit")).toBe(true);
	});

	it("returns true for a permission added by the full v1 catalogue", () => {
		expect(catalogue.isPermission("backups:restore")).toBe(true);
	});

	it("returns false for inherited-property-name lookalikes", () => {
		expect(catalogue.isPermission("constructor")).toBe(false);
		expect(catalogue.isPermission("toString")).toBe(false);
	});

	it("returns false for non-string values", () => {
		expect(catalogue.isPermission(42)).toBe(false);
	});
});
