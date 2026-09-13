import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationLockTimeoutError } from '../../src/lock.js';
import {
  applyPendingMigrations,
  migrateWithRegistry,
} from '../../src/migrate.js';
import { createSlowRaceMigration } from '../fixtures/migrations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase | undefined;

afterEach(async () => {
  if (testDb) {
    await testDb.drop();
    testDb = undefined;
  }
});

async function bookkeepingRowCount(connectionString: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM plakboek_migrations',
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function tableExists(
  connectionString: string,
  tableName: string,
): Promise<boolean> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [`public.${tableName}`],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

describe('concurrent migrators cannot double-apply (success criterion 5)', () => {
  it('under the default wait, exactly one migrator applies and the other reports it already applied', async () => {
    testDb = await createTestDatabase();
    const migrations = [createSlowRaceMigration()];

    const [resultA, resultB] = await Promise.allSettled([
      migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations,
      }),
      migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations,
      }),
    ]);

    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');

    const values = [resultA, resultB]
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);

    const appliedCount = values.filter((value) =>
      value.applied.includes('0001_slow_race'),
    ).length;
    const alreadyAppliedCount = values.filter((value) =>
      value.alreadyApplied.includes('0001_slow_race'),
    ).length;

    expect(appliedCount).toBe(1);
    expect(alreadyAppliedCount).toBe(1);
    expect(await bookkeepingRowCount(testDb.connectionString)).toBe(1);
  });

  it('under a short wait, one migrator fulfills and the other rejects with MigrationLockTimeoutError', async () => {
    testDb = await createTestDatabase();
    const migrations = [createSlowRaceMigration()];
    const raceOptions = { lockWaitMs: 200, lockPollIntervalMs: 50 };

    const [resultA, resultB] = await Promise.allSettled([
      migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations,
        ...raceOptions,
      }),
      migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations,
        ...raceOptions,
      }),
    ]);

    const settled = [resultA, resultB];
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [firstRejected] = rejected;
    if (firstRejected?.status === 'rejected') {
      expect(firstRejected.reason).toBeInstanceOf(MigrationLockTimeoutError);
    }

    expect(await tableExists(testDb.connectionString, 'race_target')).toBe(
      true,
    );
    expect(await bookkeepingRowCount(testDb.connectionString)).toBe(1);
  });

  it('without the lock, two unlocked applyPendingMigrations calls racing on separate clients do not both succeed (negative control)', async () => {
    testDb = await createTestDatabase();
    const migrations = [createSlowRaceMigration()];

    const clientA = new Client({ connectionString: testDb.connectionString });
    const clientB = new Client({ connectionString: testDb.connectionString });
    await clientA.connect();
    await clientB.connect();

    const [resultA, resultB] = await Promise.allSettled([
      applyPendingMigrations(clientA, migrations),
      applyPendingMigrations(clientB, migrations),
    ]);

    const rejectedCount = [resultA, resultB].filter(
      (result) => result.status === 'rejected',
    ).length;
    expect(rejectedCount).toBeGreaterThanOrEqual(1);

    await clientA.end();
    await clientB.end();
  });
});
