# @plakboek/db

A Postgres connection factory and a forward-only, lock-safe migration runner
for Plakboek CMS installations.

## What this package provides

- `createDb` -- a Drizzle (`drizzle-orm/postgres-js`) connection factory
  over the `postgres` (porsager) driver.
- `runMigrations` -- applies this package's own statically registered
  migrations, holding a Postgres advisory lock for the whole run so
  concurrent migrators can never double-apply (D-03). What Phase 6's deploy
  step invokes.
- `withMigrationLock`, `MigrationLockTimeoutError` -- the session-scoped
  advisory lock primitive `runMigrations` wraps around every run.
- The migration authoring convention every migration -- this package's own
  and every host/host-extension migration -- follows: see
  [`MIGRATIONS.md`](./MIGRATIONS.md).

## Install

```sh
pnpm add @plakboek/db drizzle-orm
```

`drizzle-orm` is a peer dependency: bring your own version, matching the
one this package was built against.

## `createDb`

```ts
import { createDb } from "@plakboek/db";

const { db, sql, close } = createDb({
	connectionString: process.env.DATABASE_URL!,
	maxConnections: 10, // optional, default 10
});

// db: a drizzle-orm/postgres-js database instance
// sql: the raw `postgres` tag function, for one-off queries
await close(); // ends the underlying connection pool
```

`createDb` validates the connection string's scheme (`postgres://` or
`postgresql://`) before connecting, and never echoes the supplied value in
an error -- `DbConfigError` always names the two expected schemes instead.

## `runMigrations`

```ts
import { runMigrations } from "@plakboek/db";

const result = await runMigrations({
	connectionString: process.env.DATABASE_URL!,
	lockWaitMs: 60_000, // optional, default 60000
	lockPollIntervalMs: 250, // optional, default 250
});

// result.applied: names of migrations applied by this call
// result.alreadyApplied: names that were already applied before this call
```

`runMigrations` is safe to call from every instance of a rolling deploy: it
opens its own connection, holds the advisory lock for the duration of the
run, and applies this package's statically registered `MIGRATIONS` in
order. A second overlapping call either observes the first call's
migrations as already applied, or throws `MigrationLockTimeoutError` if it
gives up waiting for the lock before the first call finishes.

`MIGRATIONS` ships empty at `0.1.0` -- no product schema exists before
Phase 2. See [`MIGRATIONS.md`](./MIGRATIONS.md) for how later phases add to
it, the transactional-vs-existence-guarded-statement decision, and what
each thrown error class means.

## Errors

| Class                            | Meaning                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DbConfigError`                  | `createDb` was given an invalid connection string.                                                                            |
| `MigrationLockTimeoutError`      | Another migrator still holds the advisory lock after `lockWaitMs`.                                                            |
| `MigrationRegistryError`         | The migration registry itself is structurally invalid.                                                                        |
| `MigrationChecksumMismatchError` | An already-applied migration's SQL no longer matches its registry entry -- shipped migrations are immutable.                  |
| `UnknownAppliedMigrationError`   | The database has a migration applied that the registry no longer contains.                                                    |
| `MigrationOrderError`            | A new migration was inserted before one already applied -- migrations must never be reordered.                                |
| `MigrationFailedError`           | A migration's SQL failed to apply; carries the failing statement index (non-transactional) and the original error as `cause`. |

Full detail, including operator guidance per error, lives in
[`MIGRATIONS.md`](./MIGRATIONS.md#errors).
