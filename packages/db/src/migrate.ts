/**
 * The forward-only, statically registered migration runner (D-03). Every
 * migration is a plain `{ name, sql, transactional }` object explicitly
 * imported into `./migrations/index.ts` -- never discovered by scanning a
 * directory. `runMigrations`/`migrateWithRegistry` hold `./lock.ts`'s
 * session-scoped advisory lock for the whole run, so two concurrent
 * migrators can never double-apply. See ../MIGRATIONS.md for the authoring
 * convention every migration must follow.
 */
import type { Client } from "pg";
import { MIGRATIONS } from "./migrations/index.js";

/** One statically registered migration. `sql` is either a single
 * transaction's worth of SQL (`transactional: true`) or a sequence of
 * independently-committed, existence-guarded statements separated by
 * `STATEMENT_BREAKPOINT` (`transactional: false`) -- required for
 * statements Postgres refuses inside a transaction block. */
export interface Migration {
	readonly name: string;
	readonly sql: string;
	readonly transactional: boolean;
}

/** Bookkeeping table created (if missing) by every run. */
export const MIGRATIONS_TABLE = "plakboek_migrations";

/** The drizzle-kit statement separator: splits a non-transactional
 * migration's `sql` into individually-run statements. */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** Thrown by `assertValidRegistry` for a structurally invalid registry: an
 * invalid name, a duplicate name, a non-increasing numeric prefix, or empty
 * sql. */
export class MigrationRegistryError extends Error {
	readonly migrationName: string | undefined;

	constructor(message: string, migrationName?: string) {
		super(message);
		this.name = "MigrationRegistryError";
		this.migrationName = migrationName;
	}
}

/** Thrown when an already-applied migration's checksum no longer matches
 * its registry entry -- shipped migrations are immutable. */
export class MigrationChecksumMismatchError extends Error {
	readonly migrationName: string;

	constructor(migrationName: string) {
		super(
			`@plakboek/db: migration "${migrationName}" has already been applied, but its SQL no longer matches -- shipped migrations are immutable, corrections are a new migration`,
		);
		this.name = "MigrationChecksumMismatchError";
		this.migrationName = migrationName;
	}
}

/** Thrown when the database has an applied migration the registry no longer
 * contains -- this package version is older than the applied schema. */
export class UnknownAppliedMigrationError extends Error {
	readonly migrationName: string;

	constructor(migrationName: string) {
		super(
			`@plakboek/db: database has migration "${migrationName}" applied, but the registry does not contain it -- refusing to proceed`,
		);
		this.name = "UnknownAppliedMigrationError";
		this.migrationName = migrationName;
	}
}

/** Thrown when the registry's order no longer matches the applied migration
 * history -- migrations must never be reordered once shipped. */
export class MigrationOrderError extends Error {
	readonly migrationName: string;

	constructor(migrationName: string) {
		super(
			`@plakboek/db: registry order does not match applied migration history at "${migrationName}" -- migrations must never be reordered`,
		);
		this.name = "MigrationOrderError";
		this.migrationName = migrationName;
	}
}

/** Thrown when a migration's SQL fails to apply. `statementIndex` is the
 * zero-based index of the failing statement for a non-transactional
 * migration, `undefined` for a transactional one (the whole migration is
 * one statement as far as failure attribution goes). */
export class MigrationFailedError extends Error {
	readonly migrationName: string;
	readonly statementIndex: number | undefined;

	constructor(migrationName: string, statementIndex: number | undefined, cause: unknown) {
		super(
			`@plakboek/db: migration "${migrationName}" failed${
				statementIndex === undefined ? "" : ` at statement index ${statementIndex}`
			}`,
			{ cause },
		);
		this.name = "MigrationFailedError";
		this.migrationName = migrationName;
		this.statementIndex = statementIndex;
	}
}

export interface RunMigrationsOptions {
	readonly connectionString: string;
	readonly lockWaitMs?: number;
	readonly lockPollIntervalMs?: number;
}

export interface RunMigrationsResult {
	readonly applied: readonly string[];
	readonly alreadyApplied: readonly string[];
}

/** sha256 hex digest of a migration's `sql`, used to detect an edited
 * shipped migration (T-01-30). */
export function migrationChecksum(_sql: string): string {
	throw new Error("not implemented");
}

/** Validates registry structure only (name pattern, uniqueness, strictly
 * increasing numeric prefix, non-empty sql) -- never touches a database.
 * Throws `MigrationRegistryError` on the first violation found. */
export function assertValidRegistry(_migrations: readonly Migration[]): void {
	throw new Error("not implemented");
}

/** Applies every pending migration in `migrations` against `client`, in
 * registry order. Does not acquire any lock -- callers that need
 * concurrency safety use `migrateWithRegistry`. Exported directly so tests
 * can prove the unlocked case has no safety (the negative control). */
export async function applyPendingMigrations(
	_client: Client,
	_migrations: readonly Migration[],
): Promise<RunMigrationsResult> {
	throw new Error("not implemented");
}

/** Validates `migrations`, opens one `pg.Client`, and runs
 * `applyPendingMigrations` inside `withMigrationLock` -- the primitive
 * `runMigrations` and every test in this package build on. */
export async function migrateWithRegistry(
	_options: RunMigrationsOptions & { readonly migrations: readonly Migration[] },
): Promise<RunMigrationsResult> {
	throw new Error("not implemented");
}

/** Applies the package's own statically registered `MIGRATIONS`. What
 * Phase 6's deploy step invokes. */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
	return migrateWithRegistry({ ...options, migrations: MIGRATIONS });
}
