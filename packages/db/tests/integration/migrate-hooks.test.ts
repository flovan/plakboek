import { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIGRATION_LOCK_KEY,
  MigrationLockTimeoutError,
} from '../../src/lock.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import { migrateWithRegistry, runMigrations } from '../../src/migrate.js';
import {
  createAlphaMigration,
  createBetaMigration,
  createGammaMigration,
} from '../fixtures/migrations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase | undefined;
const heldClients: Client[] = [];

afterEach(async () => {
  for (const client of heldClients.splice(0)) {
    await client.end().catch(() => undefined);
  }
  if (testDb) {
    await testDb.drop();
    testDb = undefined;
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A client that holds the migration advisory lock until `release()`. */
async function holdMigrationLock(
  connectionString: string,
): Promise<{ release(): Promise<void> }> {
  const client = new Client({ connectionString });
  client.on('error', () => {
    // The database drop in afterEach may terminate this backend.
  });
  await client.connect();
  heldClients.push(client);
  await client.query('SELECT pg_advisory_lock($1::bigint)', [
    MIGRATION_LOCK_KEY,
  ]);
  return {
    async release(): Promise<void> {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [
        MIGRATION_LOCK_KEY,
      ]);
    },
  };
}

const registry = (): ReturnType<typeof createAlphaMigration>[] => [
  createAlphaMigration(),
  createBetaMigration(),
  createGammaMigration(),
];

describe('migration progress hooks', () => {
  it('reports every pending migration once, in order, and never a lock wait when nobody holds the lock', async () => {
    testDb = await createTestDatabase();
    const onLockWait = vi.fn();
    const onMigrationStart = vi.fn();

    const result = await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations: registry(),
      onLockWait,
      onMigrationStart,
    });

    expect(onMigrationStart.mock.calls).toEqual([
      ['0001_create_alpha'],
      ['0002_create_beta'],
      ['0003_create_gamma'],
    ]);
    expect(result.applied).toEqual([
      '0001_create_alpha',
      '0002_create_beta',
      '0003_create_gamma',
    ]);
    expect(onLockWait).not.toHaveBeenCalled();
  });

  it('reports the packaged registry through runMigrations', async () => {
    testDb = await createTestDatabase();
    const onMigrationStart = vi.fn();

    await runMigrations({
      connectionString: testDb.connectionString,
      onMigrationStart,
    });

    expect(onMigrationStart.mock.calls.map(([name]) => name)).toEqual(
      MIGRATIONS.map((migration) => migration.name),
    );
  });

  it('never reports a migration that is already applied', async () => {
    testDb = await createTestDatabase();
    await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations: registry(),
    });
    const onMigrationStart = vi.fn();

    const second = await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations: registry(),
      onMigrationStart,
    });

    expect(second.applied).toEqual([]);
    expect(onMigrationStart).not.toHaveBeenCalled();
  });

  it('reports a held lock exactly once however many times it polls, then times out', async () => {
    testDb = await createTestDatabase();
    await holdMigrationLock(testDb.connectionString);
    const onLockWait = vi.fn();
    const onMigrationStart = vi.fn();

    await expect(
      migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations: registry(),
        lockWaitMs: 400,
        lockPollIntervalMs: 40,
        onLockWait,
        onMigrationStart,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(onLockWait).toHaveBeenCalledTimes(1);
    expect(onMigrationStart).not.toHaveBeenCalled();
  });

  it('reports the wait once, then applies everything when the lock is released mid-wait', async () => {
    testDb = await createTestDatabase();
    const held = await holdMigrationLock(testDb.connectionString);
    const onLockWait = vi.fn();
    const onMigrationStart = vi.fn();

    const run = migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations: registry(),
      lockWaitMs: 5_000,
      lockPollIntervalMs: 40,
      onLockWait,
      onMigrationStart,
    });
    await sleep(250);
    await held.release();
    const result = await run;

    expect(onLockWait).toHaveBeenCalledTimes(1);
    expect(onMigrationStart).toHaveBeenCalledTimes(3);
    expect(result.applied).toHaveLength(3);
  });

  it('is isolated from a throwing hook: the applied list matches a hook-free run', async () => {
    testDb = await createTestDatabase();
    const hookFree = await createTestDatabase();
    try {
      const baseline = await migrateWithRegistry({
        connectionString: hookFree.connectionString,
        migrations: registry(),
      });

      const onMigrationStart = vi.fn(() => {
        throw new Error('hook broke');
      });
      const withThrowingHook = await migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations: registry(),
        onMigrationStart,
        onLockWait: () => {
          throw new Error('lock hook broke');
        },
      });

      expect(onMigrationStart).toHaveBeenCalledTimes(3);
      expect(withThrowingHook).toEqual(baseline);
    } finally {
      await hookFree.drop();
    }
  });

  it('survives a throwing lock-wait hook while waiting for a held lock', async () => {
    testDb = await createTestDatabase();
    const held = await holdMigrationLock(testDb.connectionString);
    const run = migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations: registry(),
      lockWaitMs: 5_000,
      lockPollIntervalMs: 40,
      onLockWait: () => {
        throw new Error('lock hook broke');
      },
    });
    await sleep(250);
    await held.release();

    expect((await run).applied).toHaveLength(3);
  });
});
