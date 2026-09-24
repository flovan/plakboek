import { createDb } from '@plakboek/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './test-database.js';

describe('integration test harness', () => {
  it('provisions an isolated database and connects to it', async () => {
    const testDatabase = await createTestDatabase();
    try {
      expect(new URL(testDatabase.connectionString).pathname).toMatch(
        /^\/plakboek_test_/,
      );

      const handle = createDb({
        connectionString: testDatabase.connectionString,
      });
      try {
        const result = await handle.db.execute(sql`select 1 as one`);
        expect(Number(result[0]?.one)).toBe(1);
      } finally {
        await handle.close();
      }
    } finally {
      await testDatabase.drop();
    }
  });
});
