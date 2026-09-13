import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
	MigrationChecksumMismatchError,
	MigrationFailedError,
	MigrationOrderError,
	UnknownAppliedMigrationError,
	migrateWithRegistry,
} from "../../src/migrate.js";
import {
	createAlphaMigration,
	createBetaMigration,
	createBrokenTransactionalMigration,
	createGammaMigration,
	createInsertBeforeMigration,
} from "../fixtures/migrations.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";

let testDb: TestDatabase | undefined;

afterEach(async () => {
	if (testDb) {
		await testDb.drop();
		testDb = undefined;
	}
});

async function tableExists(connectionString: string, tableName: string): Promise<boolean> {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		const result = await client.query<{ exists: boolean }>(
			"SELECT to_regclass($1) IS NOT NULL AS exists",
			[`public.${tableName}`],
		);
		return result.rows[0]?.exists ?? false;
	} finally {
		await client.end();
	}
}

async function bookkeepingRowCount(connectionString: string): Promise<number> {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		const result = await client.query<{ count: string }>(
			"SELECT count(*)::int AS count FROM plakboek_migrations",
		);
		return Number(result.rows[0]?.count ?? 0);
	} finally {
		await client.end();
	}
}

describe("migrateWithRegistry (integration)", () => {
	it("applies migrations in order and is idempotent on re-run, recording checksums", async () => {
		testDb = await createTestDatabase();
		const migrations = [createAlphaMigration(), createBetaMigration()];

		const first = await migrateWithRegistry({
			connectionString: testDb.connectionString,
			migrations,
		});
		expect(first.applied).toEqual(["0001_create_alpha", "0002_create_beta"]);
		expect(first.alreadyApplied).toEqual([]);

		const second = await migrateWithRegistry({
			connectionString: testDb.connectionString,
			migrations,
		});
		expect(second.applied).toEqual([]);
		expect(second.alreadyApplied).toEqual(["0001_create_alpha", "0002_create_beta"]);

		expect(await tableExists(testDb.connectionString, "alpha")).toBe(true);
		expect(await tableExists(testDb.connectionString, "beta")).toBe(true);

		const client = new Client({ connectionString: testDb.connectionString });
		await client.connect();
		try {
			const rows = await client.query<{ name: string; checksum: string }>(
				"SELECT name, checksum FROM plakboek_migrations ORDER BY name",
			);
			expect(rows.rows).toHaveLength(2);
			for (const row of rows.rows) {
				expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
			}
		} finally {
			await client.end();
		}
	});

	it("throws MigrationChecksumMismatchError naming the edited migration and inserts nothing", async () => {
		testDb = await createTestDatabase();
		await migrateWithRegistry({
			connectionString: testDb.connectionString,
			migrations: [createAlphaMigration(), createBetaMigration()],
		});

		const editedAlpha = {
			...createAlphaMigration(),
			sql: "CREATE TABLE alpha (id serial primary key, extra int);",
		};

		let caught: unknown;
		try {
			await migrateWithRegistry({
				connectionString: testDb.connectionString,
				migrations: [editedAlpha, createBetaMigration()],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationChecksumMismatchError);
		if (caught instanceof MigrationChecksumMismatchError) {
			expect(caught.migrationName).toBe("0001_create_alpha");
		}
		expect(await bookkeepingRowCount(testDb.connectionString)).toBe(2);
	});

	it("throws UnknownAppliedMigrationError when the registry no longer contains an applied migration", async () => {
		testDb = await createTestDatabase();
		await migrateWithRegistry({
			connectionString: testDb.connectionString,
			migrations: [createAlphaMigration(), createBetaMigration()],
		});

		let caught: unknown;
		try {
			await migrateWithRegistry({
				connectionString: testDb.connectionString,
				migrations: [createAlphaMigration()],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(UnknownAppliedMigrationError);
		if (caught instanceof UnknownAppliedMigrationError) {
			expect(caught.migrationName).toBe("0002_create_beta");
		}
	});

	it("throws MigrationOrderError when a new migration is inserted before an already-applied one", async () => {
		testDb = await createTestDatabase();
		await migrateWithRegistry({
			connectionString: testDb.connectionString,
			migrations: [createAlphaMigration(), createGammaMigration()],
		});

		let caught: unknown;
		try {
			await migrateWithRegistry({
				connectionString: testDb.connectionString,
				migrations: [createAlphaMigration(), createInsertBeforeMigration(), createGammaMigration()],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationOrderError);
	});

	it("rejects a transactional migration whose second statement fails, leaving no DDL and no bookkeeping row", async () => {
		testDb = await createTestDatabase();

		let caught: unknown;
		try {
			await migrateWithRegistry({
				connectionString: testDb.connectionString,
				migrations: [createBrokenTransactionalMigration()],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationFailedError);
		if (caught instanceof MigrationFailedError) {
			expect(caught.migrationName).toBe("0001_broken_tx");
		}
		expect(await tableExists(testDb.connectionString, "broken_tx_a")).toBe(false);
		expect(await bookkeepingRowCount(testDb.connectionString)).toBe(0);
	});

	it("never includes the database password in a thrown error message", async () => {
		testDb = await createTestDatabase();
		const url = new URL(testDb.connectionString);
		const authSubstring = `${url.username}:${url.password}@`;

		await migrateWithRegistry({
			connectionString: testDb.connectionString,
			migrations: [createAlphaMigration()],
		});

		const editedAlpha = { ...createAlphaMigration(), sql: "select 1;" };

		let caught: unknown;
		try {
			await migrateWithRegistry({
				connectionString: testDb.connectionString,
				migrations: [editedAlpha],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MigrationChecksumMismatchError);
		expect(String(caught)).not.toContain(authSubstring);
		expect((caught as Error).message).not.toContain(authSubstring);
	});
});
