import { randomBytes } from "node:crypto";
import { Client } from "pg";

const DATABASE_NAME_PATTERN = /^[a-z0-9_]+$/;

export interface TestDatabase {
	readonly connectionString: string;
	drop(): Promise<void>;
}

function requireTestDatabaseUrl(): string {
	const url = process.env.TEST_DATABASE_URL;
	if (!url || url.length === 0) {
		throw new Error(
			"TEST_DATABASE_URL is not set: run `docker compose up -d --wait postgres` and export the value from .env.example",
		);
	}
	return url;
}

/**
 * Creates a fresh, isolated database on the admin connection named by
 * TEST_DATABASE_URL, and returns a connection string pointed at it plus a
 * `drop()` cleanup. The generated name is validated against a strict
 * kebab-free identifier pattern BEFORE it is interpolated into `CREATE
 * DATABASE`/`DROP DATABASE` -- it never comes from user input, but the
 * validation guards against a future caller of this helper passing an
 * unexpected prefix.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
	const adminConnectionString = requireTestDatabaseUrl();

	const databaseName = `plakboek_test_${randomBytes(6).toString("hex")}`;
	if (!DATABASE_NAME_PATTERN.test(databaseName)) {
		throw new Error(`generated test database name "${databaseName}" failed validation`);
	}

	const adminClient = new Client({ connectionString: adminConnectionString });
	await adminClient.connect();
	try {
		await adminClient.query(`CREATE DATABASE "${databaseName}"`);
	} finally {
		await adminClient.end();
	}

	const testUrl = new URL(adminConnectionString);
	testUrl.pathname = `/${databaseName}`;

	return {
		connectionString: testUrl.toString(),
		async drop(): Promise<void> {
			const dropClient = new Client({ connectionString: adminConnectionString });
			await dropClient.connect();
			try {
				await dropClient.query(
					"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
					[databaseName],
				);
				await dropClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
			} finally {
				await dropClient.end();
			}
		},
	};
}
