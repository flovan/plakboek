import { sql as sqlTemplate } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/client.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase | undefined;

afterEach(async () => {
  if (testDb) {
    await testDb.drop();
    testDb = undefined;
  }
});

describe('createDb (integration)', () => {
  it('runs a query through the drizzle db and the raw sql tag against a real Postgres, then closes cleanly', async () => {
    testDb = await createTestDatabase();
    const handle = createDb({ connectionString: testDb.connectionString });

    try {
      const dbResult = await handle.db.execute(sqlTemplate`select 1 as value`);
      expect(Number(dbResult[0]?.value)).toBe(1);

      const sqlResult = await handle.sql`select 1 as value`;
      expect(Number(sqlResult[0]?.value)).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
