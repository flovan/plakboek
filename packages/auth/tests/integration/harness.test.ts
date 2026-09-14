import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './test-database.js';

describe('integration test harness', () => {
  it('creates and drops an isolated database', async () => {
    const testDatabase = await createTestDatabase();
    const client = new Client({
      connectionString: testDatabase.connectionString,
    });
    try {
      await client.connect();
      const result = await client.query('select 1 as one');
      expect(result.rows[0]).toEqual({ one: 1 });
    } finally {
      await client.end();
      await testDatabase.drop();
    }
  });
});
