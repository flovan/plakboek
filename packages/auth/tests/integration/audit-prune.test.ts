import { createDb, runMigrations, type Db } from '@plakboek/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_RETENTION_DAYS, pruneAuditLog } from '../../src/audit-prune.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-14T12:00:00.000Z');
const now = (): Date => NOW;

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
};

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    await runMigrations({ connectionString: testDatabase.connectionString });
    current = {
      testDatabase,
      handle: createDb({ connectionString: testDatabase.connectionString }),
    };
  } catch (error) {
    await testDatabase.drop();
    throw error;
  }
});

afterEach(async () => {
  const finished = current;
  current = undefined;
  if (finished !== undefined) {
    await finished.handle.close();
    await finished.testDatabase.drop();
  }
});

/** Writes one audit row with the given label and creation instant. Rows are
 * seeded straight into the table: the prune only reads `created_at`. */
async function seedRow(label: string, createdAt: Date): Promise<void> {
  await fixture().handle.sql`
    INSERT INTO audit_log (actor_role_key, permission, action, entity_type,
                           outcome, created_at)
    VALUES ('superadmin', 'users:edit', ${label}, 'user', 'allowed',
            ${createdAt.toISOString()}::timestamptz)
  `;
}

async function remainingLabels(): Promise<string[]> {
  const rows = await fixture().handle.sql<{ action: string }[]>`
    SELECT action FROM audit_log ORDER BY id
  `;
  return rows.map((row) => row.action);
}

describe('pruneAuditLog (D-07)', () => {
  it('keeps a year of history by default', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(365);
  });

  it('deletes a row older than 365 days and keeps one younger than that', async () => {
    await seedRow('366-days-old', new Date(NOW.getTime() - 366 * DAY_MS));
    await seedRow('364-days-old', new Date(NOW.getTime() - 364 * DAY_MS));

    const deleted = await pruneAuditLog(fixture().handle.db, { now });

    expect(deleted).toBe(1);
    expect(await remainingLabels()).toEqual(['364-days-old']);
  });

  it('keeps a row created exactly at the retention boundary', async () => {
    await seedRow('at-boundary', new Date(NOW.getTime() - 365 * DAY_MS));
    await seedRow(
      'one-millisecond-past',
      new Date(NOW.getTime() - 365 * DAY_MS - 1),
    );

    const deleted = await pruneAuditLog(fixture().handle.db, { now });

    expect(deleted).toBe(1);
    expect(await remainingLabels()).toEqual(['at-boundary']);
  });

  it('returns the number of rows it deleted', async () => {
    for (const age of [400, 500, 600]) {
      await seedRow(`${age}-days-old`, new Date(NOW.getTime() - age * DAY_MS));
    }
    await seedRow('recent', new Date(NOW.getTime() - DAY_MS));

    await expect(pruneAuditLog(fixture().handle.db, { now })).resolves.toBe(3);
    expect(await remainingLabels()).toEqual(['recent']);
  });

  it('returns 0 and deletes nothing when no row is old enough', async () => {
    await seedRow('recent', new Date(NOW.getTime() - 10 * DAY_MS));

    await expect(pruneAuditLog(fixture().handle.db, { now })).resolves.toBe(0);
    await expect(pruneAuditLog(fixture().handle.db, { now })).resolves.toBe(0);
    expect(await remainingLabels()).toEqual(['recent']);
  });

  it('takes the retention window as a parameter', async () => {
    await seedRow('two-days-old', new Date(NOW.getTime() - 2 * DAY_MS));
    await seedRow('twelve-hours-old', new Date(NOW.getTime() - DAY_MS / 2));

    const deleted = await pruneAuditLog(fixture().handle.db, {
      retentionDays: 1,
      now,
    });

    expect(deleted).toBe(1);
    expect(await remainingLabels()).toEqual(['twelve-hours-old']);
  });

  it('throws, deleting nothing, for a window that is not a positive integer', async () => {
    await seedRow('ten-days-old', new Date(NOW.getTime() - 10 * DAY_MS));
    await seedRow('an-hour-old', new Date(NOW.getTime() - DAY_MS / 24));

    for (const retentionDays of [
      0,
      -1,
      -365,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        pruneAuditLog(fixture().handle.db, { retentionDays, now }),
      ).rejects.toThrow(/@plakboek\/auth/);
    }
    expect(await remainingLabels()).toEqual(['ten-days-old', 'an-hour-old']);
  });
});
