import type { Client } from 'pg';

/**
 * Fixed advisory-lock key reserved for @plakboek/db's migration runner.
 * Postgres advisory locks share a single namespace per database across every
 * caller -- this key must never be reused by another subsystem within a
 * @plakboek/db-managed database.
 */
export const MIGRATION_LOCK_KEY = '4839120657231098713';

export class MigrationLockTimeoutError extends Error {
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(
      `@plakboek/db: another migrator still holds the migration lock after ${waitedMs}ms`,
    );
    this.name = 'MigrationLockTimeoutError';
    this.waitedMs = waitedMs;
  }
}

export type LockOptions = {
  readonly waitMs?: number;
  readonly pollIntervalMs?: number;
};

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquire(client: Client): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    [MIGRATION_LOCK_KEY],
  );
  return result.rows[0]?.locked ?? false;
}

/**
 * Polls `pg_try_advisory_lock` (never a blocking `pg_advisory_lock`) until it
 * succeeds or `waitMs` elapses. A fail-fast try-lock plus bounded polling was
 * chosen over `SET lock_timeout` + a blocking acquire because `lock_timeout`
 * is a session setting: it would persist on this client for every statement
 * run afterwards, including the migrations `withMigrationLock` wraps.
 */
async function acquire(
  client: Client,
  waitMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await tryAcquire(client)) return;
    const elapsedMs = Date.now() - start;
    if (elapsedMs >= waitMs) {
      throw new MigrationLockTimeoutError(elapsedMs);
    }
    await sleep(pollIntervalMs);
  }
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function runGuarded<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Runs `fn` while holding a session-scoped Postgres advisory lock keyed by
 * `MIGRATION_LOCK_KEY`, acquired on the caller-supplied dedicated `client`.
 * Two callers can never be inside `fn` at the same time; a caller that gives
 * up waiting throws `MigrationLockTimeoutError`. If the holding backend
 * crashes or is terminated, Postgres releases the session lock itself, so a
 * waiting caller acquires it without needing this function to run at all.
 *
 * Never issues `SET`/`SET LOCAL` on `client` -- the lock is acquired and
 * released purely via `pg_try_advisory_lock`/`pg_advisory_unlock`, so no
 * session setting (e.g. `lock_timeout`) leaks into statements `fn` runs
 * afterwards on the same client.
 *
 * The unlock query always runs after `fn` settles (success or failure) --
 * this is expressed as unconditional sequential code (not a `try/finally`)
 * so returning `outcome.value` never needs an unsafe cast to narrow `T`. The
 * unlock query itself is guarded the same way `fn` is: if `fn` already
 * succeeded (its work is already durable in Postgres) and the unlock query
 * then fails -- e.g. the connection drops between commit and unlock -- that
 * failure is logged rather than thrown, so a lock-release problem can never
 * discard an already-successful `outcome.value`. Postgres releases a
 * session-scoped advisory lock automatically once the session disconnects,
 * so a failed unlock does not leave the lock stuck. If `fn` itself failed,
 * `fn`'s error is what gets thrown regardless of the unlock outcome.
 */
export async function withMigrationLock<T>(
  client: Client,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  await acquire(client, waitMs, pollIntervalMs);

  const outcome = await runGuarded(fn);

  const unlockOutcome = await runGuarded(() =>
    client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
      [MIGRATION_LOCK_KEY],
    ),
  );

  if (outcome.ok) {
    if (!unlockOutcome.ok) {
      // fn already succeeded and committed its work -- never let a failure
      // to release the lock discard that result. See the doc comment above.
      // oxlint-disable-next-line no-console -- last-resort report: outcome.value must not be lost over a lock-release failure
      console.error(
        '@plakboek/db: migrations applied successfully, but releasing the migration lock failed -- the lock releases automatically once this session disconnects',
        unlockOutcome.error,
      );
      return outcome.value;
    }

    const unlocked = unlockOutcome.value.rows[0]?.unlocked ?? false;
    if (!unlocked) {
      throw new Error(
        '@plakboek/db: migration lock was not held at release -- this indicates a bug in withMigrationLock or an external pg_advisory_unlock call on the same key',
      );
    }
    return outcome.value;
  }

  throw outcome.error;
}
