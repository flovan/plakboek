import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	MigrationRegistryError,
	assertValidRegistry,
	migrationChecksum,
} from "../../src/migrate.js";
import { MIGRATIONS } from "../../src/migrations/index.js";

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../src/migrations", import.meta.url));
const INDEX_PATH = path.join(MIGRATIONS_DIR, "index.ts");

describe("shipped MIGRATIONS registry", () => {
	it("is a frozen array and passes assertValidRegistry", () => {
		expect(Object.isFrozen(MIGRATIONS)).toBe(true);
		expect(() => assertValidRegistry(MIGRATIONS)).not.toThrow();
	});
});

describe("assertValidRegistry", () => {
	it("throws MigrationRegistryError for a name not matching ^\\d{4}_[a-z0-9_]+$", () => {
		expect(() =>
			assertValidRegistry([{ name: "1_bad", sql: "select 1;", transactional: true }]),
		).toThrow(MigrationRegistryError);
		expect(() =>
			assertValidRegistry([{ name: "0001-bad", sql: "select 1;", transactional: true }]),
		).toThrow(MigrationRegistryError);
		expect(() =>
			assertValidRegistry([{ name: "0001_Bad", sql: "select 1;", transactional: true }]),
		).toThrow(MigrationRegistryError);
	});

	it("throws MigrationRegistryError for a duplicate name", () => {
		expect(() =>
			assertValidRegistry([
				{ name: "0001_alpha", sql: "select 1;", transactional: true },
				{ name: "0001_alpha", sql: "select 2;", transactional: true },
			]),
		).toThrow(MigrationRegistryError);
	});

	it("throws MigrationRegistryError for a numeric prefix that is not strictly increasing", () => {
		expect(() =>
			assertValidRegistry([
				{ name: "0002_alpha", sql: "select 1;", transactional: true },
				{ name: "0001_beta", sql: "select 2;", transactional: true },
			]),
		).toThrow(MigrationRegistryError);
		expect(() =>
			assertValidRegistry([
				{ name: "0001_alpha", sql: "select 1;", transactional: true },
				{ name: "0001_beta", sql: "select 2;", transactional: true },
			]),
		).toThrow(MigrationRegistryError);
	});

	it("throws MigrationRegistryError for empty sql", () => {
		expect(() =>
			assertValidRegistry([{ name: "0001_alpha", sql: "   ", transactional: true }]),
		).toThrow(MigrationRegistryError);
	});

	it("does not throw for a valid, strictly-increasing registry", () => {
		expect(() =>
			assertValidRegistry([
				{ name: "0001_alpha", sql: "select 1;", transactional: true },
				{ name: "0002_beta", sql: "select 2;", transactional: true },
			]),
		).not.toThrow();
	});
});

describe("migrationChecksum", () => {
	it("returns the same 64-char lowercase hex on every call", () => {
		const first = migrationChecksum("select 1;");
		const second = migrationChecksum("select 1;");
		expect(first).toBe(second);
		expect(first).toMatch(HEX64_PATTERN);
	});

	it("returns a different digest for different sql", () => {
		expect(migrationChecksum("select 1;")).not.toBe(migrationChecksum("select 2;"));
	});
});

describe("migration registry completeness (D-03)", () => {
	it("imports every .ts file in src/migrations other than index.ts", () => {
		const files = readdirSync(MIGRATIONS_DIR).filter(
			(file) => file.endsWith(".ts") && file !== "index.ts",
		);
		const indexSource = readFileSync(INDEX_PATH, "utf8");

		for (const file of files) {
			const moduleName = file.replace(/\.ts$/, "");
			expect(indexSource.includes(`./${moduleName}.js`)).toBe(true);
		}
	});

	it("never imports the filesystem or uses a dynamic import", () => {
		const indexSource = readFileSync(INDEX_PATH, "utf8");
		expect(indexSource).not.toMatch(/from\s+["']node:fs["']/);
		expect(indexSource).not.toMatch(/from\s+["']fs["']/);
		expect(indexSource).not.toMatch(/require\(/);
		expect(indexSource).not.toMatch(/import\s*\(/);
	});
});
