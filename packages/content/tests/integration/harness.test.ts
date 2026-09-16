import { runMigrations } from '@plakboek/db';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './test-database.js';

describe('integration test harness', () => {
  it('provisions a database, runs the shared migration registry and drops it', async () => {
    const testDatabase = await createTestDatabase();
    try {
      await runMigrations({ connectionString: testDatabase.connectionString });

      const client = new Client({
        connectionString: testDatabase.connectionString,
      });
      try {
        await client.connect();
        const result = await client.query<{ count: string }>(
          'select count(*) from audit_log',
        );
        expect(result.rows[0]).toEqual({ count: '0' });
      } finally {
        await client.end();
      }
    } finally {
      await testDatabase.drop();
    }
  });
});
