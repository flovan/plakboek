# Writing migrations for @plakboek/db

This is the authoring convention every migration in `src/migrations/`
follows, starting with the very first one Phase 2 adds. The runner that
enforces it lives in `src/migrate.ts`; see `README.md` for how to invoke
`runMigrations`.

## Rules

- **Forward-only.** There is no `down` migration and no rollback mechanism.
  Correcting a mistake means writing a new migration that fixes it, never
  editing history.
- **Shipped migrations are immutable, and this is enforced.** Once a
  migration has been applied anywhere, its `sql` must never change. The
  runner stores a sha256 checksum of every applied migration's `sql`
  alongside its name; if the checksum no longer matches, `runMigrations`
  throws `MigrationChecksumMismatchError` and refuses to proceed.
- **Registry order is the only order.** Migrations apply in the exact
  sequence they appear in `src/migrations/index.ts`'s `MIGRATIONS` array.
  Inserting a new entry before one that has already been applied anywhere
  throws `MigrationOrderError` -- there is no way to retroactively change
  when a migration ran.

## Adding a migration

1. Create `src/migrations/NNNN_snake_case_name.ts`, exporting a `Migration`
   object (see `src/migrate.ts` for the `Migration` interface: `name`,
   `sql`, `transactional`). `NNNN` is a four-digit, strictly increasing
   prefix; `name` must match `^\d{4}_[a-z0-9_]+$` and match the file name.
2. Add an explicit static `import` for the new module in
   `src/migrations/index.ts` -- never a directory scan. A migration file
   that exists but is not imported there fails this package's own unit
   test suite (D-03).
3. Append the migration to the `MIGRATIONS` array, after every
   already-shipped entry.

SQL may be generated with `drizzle-kit generate` from a Drizzle schema, then
reviewed and pasted into the migration module's `sql` string -- drizzle-kit
is a convenience for producing correct SQL text, not something this
package's own migrator invokes at runtime.

## Transactions

`transactional` is `true` by default for a migration whose statements can
safely run inside one `BEGIN`/`COMMIT` block. Set it to `false` only for
statements Postgres refuses to run inside a transaction block -- for
example `CREATE INDEX CONCURRENTLY`, or `ALTER TYPE ... ADD VALUE` followed
by a statement that uses the new value in the same migration.

When `transactional` is `false`, separate each statement with the
drizzle-kit statement-breakpoint marker (`STATEMENT_BREAKPOINT` in
`src/migrate.ts`, `--> statement-breakpoint`). Each statement then runs and
commits independently -- which means **a non-transactional migration can
genuinely partially apply** if a later statement fails. Every statement in
a non-transactional migration must therefore be existence-guarded (see
below), so a re-run after a partial failure is always safe.

A transactional migration either applies completely or not at all: on
failure the runner issues `ROLLBACK`, so its statements never need
existence guards for the migration's own re-run safety. Guard them anyway
if the same statement might also run against a database that already has
the object for another reason (e.g. a manually-created table during local
development).

## Existence guards

Use these so a statement is safe to run against a database that may
already have the object, whether from a prior partial application or from
manual intervention:

- `CREATE TABLE IF NOT EXISTS ...`
- `CREATE INDEX IF NOT EXISTS ...`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
- `DROP ... IF EXISTS ...`
- `ALTER TYPE ... ADD VALUE IF NOT EXISTS ...`
- A `DO $$ ... END $$;` block that checks `to_regclass(...)` (for
  tables/indexes) or queries `pg_constraint` (for constraints) before
  running a statement with no `IF NOT EXISTS` form of its own, such as
  `ADD CONSTRAINT`.

## Expand and contract

Never drop or rename a column in the same migration -- the same deploy --
as the application code that stops referencing it. Expand the schema first
(add the new column, backfill, deploy code that writes both), then contract
in a later migration once every running instance is known to be on code
that no longer reads the old shape. Old code must keep working against an
already-expanded schema; new code must keep working against a schema whose
backfill hasn't finished yet.

## Concurrency

`runMigrations` holds `./lock.ts`'s session-scoped Postgres advisory lock
for the entire run. A second migrator that starts while the lock is held
polls until it can acquire the lock (`lockWaitMs`, default `60000`ms) or
throws `MigrationLockTimeoutError` once that deadline elapses. This is what
makes it safe for two overlapping deploy processes to both invoke
`runMigrations` against the same database: at most one of them ever applies
a given migration; the other either waits and then observes it as already
applied, or times out.

## Errors

| Error                                     | Thrown when                                                                                                                                                                                               | Operator action                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MigrationRegistryError`                  | The registry itself is structurally invalid: a bad name, a duplicate name, a non-increasing numeric prefix, or empty `sql`.                                                                               | Fix the registry in code; this is a bug in the shipped package or a host's own migration file, never a database-state problem.                                                                             |
| `MigrationChecksumMismatchError`          | An already-applied migration's `sql` no longer matches what's in the database.                                                                                                                            | A shipped migration was edited after release. Revert the edit; write a new migration for the intended change instead.                                                                                      |
| `UnknownAppliedMigrationError`            | The database has a migration applied that the current registry doesn't contain.                                                                                                                           | The database is ahead of this package version. Upgrade the package, or investigate how an unrecognized migration got applied.                                                                              |
| `MigrationOrderError`                     | The applied migration history no longer matches the registry's order (a new entry was inserted before one already applied).                                                                               | A migration was inserted out of order. Renumber it to come after every already-applied migration; migrations must never be reordered once shipped.                                                         |
| `MigrationFailedError`                    | A migration's SQL failed to apply. Carries `statementIndex` (the zero-based failing statement) for a non-transactional migration, `undefined` for a transactional one, and the original error as `cause`. | Inspect `cause` for the underlying Postgres error. Fix the root cause (missing gate, permissions, syntax), then simply re-run `runMigrations` -- an existence-guarded migration is safe to retry.          |
| `MigrationLockTimeoutError` (`./lock.ts`) | Another migrator still holds the advisory lock after `lockWaitMs`. Carries `waitedMs`.                                                                                                                    | Wait and retry, or investigate whether the other migrator is stuck (a crashed holder releases the lock automatically -- Postgres drops session-scoped advisory locks when the owning backend disconnects). |

No thrown error ever includes the connection string or password -- every
message names migrations and statement indexes only.

## Why not Drizzle's `migrate()`

`drizzle-orm`'s own Postgres migrator reads migration files from disk at
runtime and batches every pending migration for one `migrate()` call into a
single transaction (`drizzle-team/drizzle-orm#3249`), with no built-in
concurrency protection (`drizzle-team/drizzle-orm#874`, open). Batching
everything into one transaction is incompatible with this package's
existence-guard convention (a `CREATE INDEX CONCURRENTLY` or an
enum-then-use migration needs its own transaction boundary), and the
absence of any lock hook to extend means concurrency safety would have to
be bolted on from outside `migrate()` anyway. `@plakboek/db` ships its own
apply loop (`applyPendingMigrations`) instead, giving each migration
explicit control over its own transaction boundary and checksum-verified
history from the first migration.
