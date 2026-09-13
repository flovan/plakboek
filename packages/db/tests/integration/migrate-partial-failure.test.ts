import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationFailedError,
  migrateWithRegistry,
} from '../../src/migrate.js';
import {
  createPartialSplitMigration,
  createPartialTransactionalMigration,
} from '../fixtures/migrations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase | undefined;

afterEach(async () => {
  if (testDb) {
    await testDb.drop();
    testDb = undefined;
  }
});

async function tableExists(
  connectionString: string,
  relationName: string,
): Promise<boolean> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [`public.${relationName}`],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

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

async function createGateTable(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE partial_failure_gate (id serial primary key)',
    );
  } finally {
    await client.end();
  }
}

describe('re-running after a partial non-transactional failure completes cleanly', () => {
  it('run 1 fails at statement index 2, leaving partial_a and its index but not partial_b, and no bookkeeping row', async () => {
    testDb = await createTestDatabase();
    const migrations = [createPartialSplitMigration()];

    let caught: unknown;
    try {
      await migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationFailedError);
    if (caught instanceof MigrationFailedError) {
      expect(caught.migrationName).toBe('0001_partial_split');
      expect(caught.statementIndex).toBe(2);
    }
    expect(await tableExists(testDb.connectionString, 'partial_a')).toBe(true);
    expect(await tableExists(testDb.connectionString, 'partial_a_id_idx')).toBe(
      true,
    );
    expect(await tableExists(testDb.connectionString, 'partial_b')).toBe(false);
    expect(await bookkeepingRowCount(testDb.connectionString)).toBe(0);
  });

  it('run 2 after the gate exists completes the migration; run 3 applies nothing', async () => {
    testDb = await createTestDatabase();
    const migrations = [createPartialSplitMigration()];

    await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations,
    }).catch(() => undefined);
    await createGateTable(testDb.connectionString);

    const second = await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations,
    });
    expect(second.applied).toEqual(['0001_partial_split']);
    expect(await tableExists(testDb.connectionString, 'partial_b')).toBe(true);

    const third = await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations,
    });
    expect(third.applied).toEqual([]);
    expect(third.alreadyApplied).toEqual(['0001_partial_split']);
  });
});

describe('re-running after a partial transactional failure completes cleanly', () => {
  it('run 1 rejects and rolls back every statement, including the first', async () => {
    testDb = await createTestDatabase();
    const migrations = [createPartialTransactionalMigration()];

    let caught: unknown;
    try {
      await migrateWithRegistry({
        connectionString: testDb.connectionString,
        migrations,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationFailedError);
    if (caught instanceof MigrationFailedError) {
      expect(caught.migrationName).toBe('0001_partial_tx');
    }
    expect(await tableExists(testDb.connectionString, 'partial_tx_a')).toBe(
      false,
    );
    expect(await bookkeepingRowCount(testDb.connectionString)).toBe(0);
  });

  it('run 2 after the gate exists applies the migration', async () => {
    testDb = await createTestDatabase();
    const migrations = [createPartialTransactionalMigration()];

    await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations,
    }).catch(() => undefined);
    await createGateTable(testDb.connectionString);

    const second = await migrateWithRegistry({
      connectionString: testDb.connectionString,
      migrations,
    });
    expect(second.applied).toEqual(['0001_partial_tx']);
    expect(await tableExists(testDb.connectionString, 'partial_tx_a')).toBe(
      true,
    );
    expect(await tableExists(testDb.connectionString, 'partial_tx_b')).toBe(
      true,
    );
  });
});
