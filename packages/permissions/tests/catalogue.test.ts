import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, isPermission, PERMISSIONS } from "../src/catalogue.js";

const EXPECTED_PAGES_PERMISSIONS = [
	"pages:read",
	"pages:read-drafts",
	"pages:create",
	"pages:edit",
	"pages:publish",
	"pages:delete",
	"pages:delete-permanent",
] as const;

describe("ALL_PERMISSIONS", () => {
	it("contains the seven pages permissions in declaration order", () => {
		expect(ALL_PERMISSIONS).toStrictEqual(EXPECTED_PAGES_PERMISSIONS);
	});
});

describe("catalogue immutability", () => {
	it("throws when assigning a new key on PERMISSIONS", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the readonly catalogue shape
			PERMISSIONS["pages:own-edit"] = PERMISSIONS["pages:edit"];
		}).toThrow(TypeError);
	});

	it("throws when replacing PERMISSIONS['pages:edit'].label", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the frozen metadata shape
			PERMISSIONS["pages:edit"].label = { id: "x", message: "x" };
		}).toThrow(TypeError);
	});

	it("throws when pushing onto ALL_PERMISSIONS", () => {
		expect(() => {
			// @ts-expect-error -- intentionally violating the frozen array
			ALL_PERMISSIONS.push("pages:read");
		}).toThrow(TypeError);
	});
});

describe("isPermission", () => {
	it("returns true for a known permission string", () => {
		expect(isPermission("pages:edit")).toBe(true);
	});

	it("returns false for inherited-property-name lookalikes", () => {
		expect(isPermission("constructor")).toBe(false);
		expect(isPermission("toString")).toBe(false);
	});

	it("returns false for non-string values", () => {
		expect(isPermission(42)).toBe(false);
	});
});
