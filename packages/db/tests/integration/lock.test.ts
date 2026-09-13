import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationLockTimeoutError,
  MIGRATION_LOCK_KEY,
  withMigrationLock,
} from '../../src/lock.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase | undefined;

afterEach(async () => {
  if (testDb) {
    await testDb.drop();
    testDb = undefined;
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noop(): void {
  // Placeholder for `releaseA` until the Promise executor below assigns the
  // real resolver -- never actually invoked in that shape.
}

/**
 * A fresh, connected pg.Client with a no-op "error" listener attached. Every
 * test in this file may leave a client connected past a failing assertion,
 * and the afterEach hook's `testDb.drop()` terminates any backends still
 * attached to the dropped database -- without a listener, that termination
 * surfaces as an uncaught exception (pg.Client's default behavior for an
 * unlistened "error" event) rather than a clean test failure.
 */
async function connectClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  client.on('error', () => {
    // Swallowed deliberately -- see function doc above.
  });
  await client.connect();
  return client;
}

async function endQuietly(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // The connection may already be closed (e.g. terminated by an admin
    // command or by the database drop in afterEach).
  }
}

describe('withMigrationLock (integration)', () => {
  it("keeps the lock held while A's function runs, and rejects a waiting client B with a bounded MigrationLockTimeoutError", async () => {
    testDb = await createTestDatabase();
    const clientA = await connectClient(testDb.connectionString);
    const clientB = await connectClient(testDb.connectionString);

    let releaseA: () => void = noop;
    const releaseAPromise = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const aPromise = withMigrationLock(clientA, async () => {
      await releaseAPromise;
    }).catch(() => undefined);

    // Give A a real chance to acquire the lock before B contends for it.
    await sleep(100);

    const start = Date.now();
    let caught: unknown;
    try {
      await withMigrationLock(
        clientB,
        async () => {
          // B's callback does nothing -- this test only cares about the
          // wait/timeout behavior of acquiring the lock itself.
        },
        { waitMs: 300, pollIntervalMs: 50 },
      );
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    const lockTimeoutError =
      caught instanceof MigrationLockTimeoutError ? caught : undefined;
    expect(lockTimeoutError).toBeInstanceOf(MigrationLockTimeoutError);
    expect(lockTimeoutError?.waitedMs).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeGreaterThanOrEqual(300);

    releaseA();
    await aPromise;

    await endQuietly(clientA);
    await endQuietly(clientB);
  });

  it("serializes callers: B's function starts only after A's function has finished", async () => {
    testDb = await createTestDatabase();
    const clientA = await connectClient(testDb.connectionString);
    const clientB = await connectClient(testDb.connectionString);

    const sequence: string[] = [];

    const aPromise = withMigrationLock(clientA, async () => {
      sequence.push('A-start');
      await sleep(300);
      sequence.push('A-end');
    }).catch(() => undefined);

    // Ensure A starts (and, with a working implementation, acquires) first.
    await sleep(50);

    const bPromise = withMigrationLock(
      clientB,
      async () => {
        sequence.push('B-start');
      },
      { pollIntervalMs: 50 },
    ).catch(() => undefined);

    await aPromise;
    await bPromise;

    expect(sequence).toEqual(['A-start', 'A-end', 'B-start']);

    await endQuietly(clientA);
    await endQuietly(clientB);
  });

  it('propagates the thrown error from fn and releases the lock so a third client can acquire it immediately afterwards', async () => {
    testDb = await createTestDatabase();
    const clientA = await connectClient(testDb.connectionString);
    const clientC = await connectClient(testDb.connectionString);

    const boom = new Error('boom');
    let caught: unknown;
    try {
      await withMigrationLock(clientA, async () => {
        throw boom;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);

    const result = await clientC.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [MIGRATION_LOCK_KEY],
    );
    expect(result.rows[0]?.locked).toBe(true);
    await clientC.query('SELECT pg_advisory_unlock($1::bigint)', [
      MIGRATION_LOCK_KEY,
    ]);

    await endQuietly(clientA);
    await endQuietly(clientC);
  });

  it('releases the lock when the holding backend is terminated, letting a waiting client acquire it', async () => {
    testDb = await createTestDatabase();
    const clientA = await connectClient(testDb.connectionString);
    const clientB = await connectClient(testDb.connectionString);
    const adminClient = await connectClient(testDb.connectionString);

    const pidResult = await clientA.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const pid = pidResult.rows[0]?.pid;
    expect(pid).toBeDefined();

    const aPromise = withMigrationLock(clientA, async () => {
      await clientA.query('SELECT pg_sleep(10)');
    }).catch(() => undefined);

    // Give a real implementation time to acquire the lock before we kill it.
    await sleep(100);

    await adminClient.query('SELECT pg_terminate_backend($1::int)', [pid]);

    let caught: unknown;
    let result: unknown;
    try {
      result = await withMigrationLock(clientB, async () => 'B-ran', {
        waitMs: 5000,
        pollIntervalMs: 100,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(result).toBe('B-ran');

    await aPromise;
    await endQuietly(clientB);
    await endQuietly(adminClient);
    await endQuietly(clientA);
  });

  it('leaves session settings on the client untouched: SHOW lock_timeout is unchanged before and after', async () => {
    testDb = await createTestDatabase();
    const client = await connectClient(testDb.connectionString);

    const before = await client.query<{ lock_timeout: string }>(
      'SHOW lock_timeout',
    );

    let caught: unknown;
    try {
      await withMigrationLock(client, async () => {
        // No-op callback -- this test only checks that lock_timeout is
        // unaffected by acquiring and releasing the lock.
      });
    } catch (error) {
      caught = error;
    }

    const after = await client.query<{ lock_timeout: string }>(
      'SHOW lock_timeout',
    );

    expect(caught).toBeUndefined();
    expect(after.rows[0]?.lock_timeout).toBe(before.rows[0]?.lock_timeout);

    await endQuietly(client);
  });
});
