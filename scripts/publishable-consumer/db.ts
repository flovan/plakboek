import {
	MigrationChecksumMismatchError,
	createDb,
	runMigrations,
	type Db,
	type Migration,
	type RunMigrationsOptions,
	type RunMigrationsResult,
} from "@plakboek/db";

function makeDb(connectionString: string): Db {
	return createDb({ connectionString });
}

async function applyMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
	return runMigrations(options);
}

const exampleMigration: Migration = {
	name: "0001_example",
	sql: "select 1;",
	transactional: true,
};

console.log(
	typeof makeDb,
	typeof applyMigrations,
	typeof MigrationChecksumMismatchError,
	exampleMigration.name,
);
