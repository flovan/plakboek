/**
 * The forward-only, statically registered migration runner (D-03). Every
 * migration is a plain `{ name, sql, transactional }` object explicitly
 * imported into `./migrations/index.ts` -- never discovered by scanning a
 * directory. `runMigrations`/`migrateWithRegistry` hold `./lock.ts`'s
 * session-scoped advisory lock for the whole run, so two concurrent
 * migrators can never double-apply. See ../MIGRATIONS.md for the authoring
 * convention every migration must follow.
 */
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { withMigrationLock } from './lock.js';
import { MIGRATIONS } from './migrations/index.js';

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
export const MIGRATIONS_TABLE = 'plakboek_migrations';

/** The drizzle-kit statement separator: splits a non-transactional
 * migration's `sql` into individually-run statements. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** Thrown by `assertValidRegistry` for a structurally invalid registry: an
 * invalid name, a duplicate name, a non-increasing numeric prefix, or empty
 * sql. */
export class MigrationRegistryError extends Error {
  readonly migrationName: string | undefined;

  constructor(message: string, migrationName?: string) {
    super(message);
    this.name = 'MigrationRegistryError';
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
    this.name = 'MigrationChecksumMismatchError';
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
    this.name = 'UnknownAppliedMigrationError';
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
    this.name = 'MigrationOrderError';
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

  constructor(
    migrationName: string,
    statementIndex: number | undefined,
    cause: unknown,
  ) {
    super(
      `@plakboek/db: migration "${migrationName}" failed${
        statementIndex === undefined
          ? ''
          : ` at statement index ${statementIndex}`
      }`,
      { cause },
    );
    this.name = 'MigrationFailedError';
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

const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+$/;

/** sha256 hex digest of a migration's `sql`, used to detect an edited
 * shipped migration (T-01-30). */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Validates registry structure only (name pattern, uniqueness, strictly
 * increasing numeric prefix, non-empty sql) -- never touches a database.
 * Throws `MigrationRegistryError` on the first violation found. */
export function assertValidRegistry(migrations: readonly Migration[]): void {
  const seenNames = new Set<string>();
  let previousPrefix = -1;

  for (const migration of migrations) {
    if (!MIGRATION_NAME_PATTERN.test(migration.name)) {
      throw new MigrationRegistryError(
        `@plakboek/db: migration name "${migration.name}" does not match ${MIGRATION_NAME_PATTERN.source}`,
        migration.name,
      );
    }

    if (seenNames.has(migration.name)) {
      throw new MigrationRegistryError(
        `@plakboek/db: duplicate migration name "${migration.name}"`,
        migration.name,
      );
    }
    seenNames.add(migration.name);

    const prefix = Number.parseInt(migration.name.slice(0, 4), 10);
    if (prefix <= previousPrefix) {
      throw new MigrationRegistryError(
        `@plakboek/db: migration "${migration.name}" has a numeric prefix that is not strictly increasing`,
        migration.name,
      );
    }
    previousPrefix = prefix;

    if (migration.sql.trim().length === 0) {
      throw new MigrationRegistryError(
        `@plakboek/db: migration "${migration.name}" has empty sql`,
        migration.name,
      );
    }
  }
}

interface AppliedRow {
  readonly name: string;
  readonly checksum: string;
}

async function ensureBookkeepingTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
			name text PRIMARY KEY,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`,
  );
}

async function readAppliedRows(client: Client): Promise<AppliedRow[]> {
  const result = await client.query<AppliedRow>(
    `SELECT name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY applied_at ASC, name ASC`,
  );
  return result.rows;
}

/** Checks every applied row against the registry (unknown / checksum
 * mismatch) and that the applied names are exactly the registry's prefix,
 * in order -- never lets a reordered or edited history proceed silently. */
function validateAppliedHistory(
  appliedRows: readonly AppliedRow[],
  migrations: readonly Migration[],
): void {
  const byName = new Map(
    migrations.map((migration) => [migration.name, migration]),
  );

  for (const row of appliedRows) {
    const migration = byName.get(row.name);
    if (!migration) {
      throw new UnknownAppliedMigrationError(row.name);
    }
    if (migrationChecksum(migration.sql) !== row.checksum) {
      throw new MigrationChecksumMismatchError(row.name);
    }
  }

  const appliedNames = appliedRows.map((row) => row.name);
  const registryPrefix = migrations.slice(0, appliedNames.length);

  for (const [index, appliedName] of appliedNames.entries()) {
    const expected = registryPrefix[index];
    if (!expected || expected.name !== appliedName) {
      throw new MigrationOrderError(appliedName);
    }
  }
}

async function recordApplied(
  client: Client,
  migration: Migration,
): Promise<void> {
  await client.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
    [migration.name, migrationChecksum(migration.sql)],
  );
}

async function applyTransactional(
  client: Client,
  migration: Migration,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await recordApplied(client, migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new MigrationFailedError(migration.name, undefined, error);
  }
}

async function applyNonTransactional(
  client: Client,
  migration: Migration,
): Promise<void> {
  const statements = migration.sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const [index, statement] of statements.entries()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- statements within one migration must apply in order
      await client.query(statement);
    } catch (error) {
      throw new MigrationFailedError(migration.name, index, error);
    }
  }

  await recordApplied(client, migration);
}

/** Applies every pending migration in `migrations` against `client`, in
 * registry order. Does not acquire any lock -- callers that need
 * concurrency safety use `migrateWithRegistry`. Exported directly so tests
 * can prove the unlocked case has no safety (the negative control). */
export async function applyPendingMigrations(
  client: Client,
  migrations: readonly Migration[],
): Promise<RunMigrationsResult> {
  await ensureBookkeepingTable(client);

  const appliedRows = await readAppliedRows(client);
  validateAppliedHistory(appliedRows, migrations);

  const alreadyApplied = appliedRows.map((row) => row.name);
  const alreadyAppliedSet = new Set(alreadyApplied);
  const pending = migrations.filter(
    (migration) => !alreadyAppliedSet.has(migration.name),
  );

  const applied: string[] = [];
  for (const migration of pending) {
    if (migration.transactional) {
      // oxlint-disable-next-line no-await-in-loop -- migrations must apply in registry order, one at a time
      await applyTransactional(client, migration);
    } else {
      // oxlint-disable-next-line no-await-in-loop -- migrations must apply in registry order, one at a time
      await applyNonTransactional(client, migration);
    }
    applied.push(migration.name);
  }

  return { applied, alreadyApplied };
}

/** Validates `migrations`, opens one `pg.Client`, and runs
 * `applyPendingMigrations` inside `withMigrationLock` -- the primitive
 * `runMigrations` and every test in this package build on. */
export async function migrateWithRegistry(
  options: RunMigrationsOptions & { readonly migrations: readonly Migration[] },
): Promise<RunMigrationsResult> {
  assertValidRegistry(options.migrations);

  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    return await withMigrationLock(
      client,
      () => applyPendingMigrations(client, options.migrations),
      {
        waitMs: options.lockWaitMs,
        pollIntervalMs: options.lockPollIntervalMs,
      },
    );
  } finally {
    await client.end();
  }
}

/** Applies the package's own statically registered `MIGRATIONS`. What
 * Phase 6's deploy step invokes. */
export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  return migrateWithRegistry({ ...options, migrations: MIGRATIONS });
}
