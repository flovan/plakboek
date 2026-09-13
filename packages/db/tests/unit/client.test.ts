import { describe, expect, it } from 'vitest';
import { createDb, DbConfigError } from '../../src/client.js';

describe('createDb', () => {
  it('rejects a non-Postgres connection string without leaking the input', () => {
    let caught: unknown;
    try {
      createDb({ connectionString: 'mysql://user:s3cret@host/db' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DbConfigError);
    if (!(caught instanceof DbConfigError)) {
      throw new Error('expected caught to be a DbConfigError');
    }
    expect(caught.message).not.toContain('s3cret');
    expect(caught.message).not.toContain('mysql://user:s3cret@host/db');
  });

  it('rejects an empty connection string', () => {
    expect(() => createDb({ connectionString: '' })).toThrow(DbConfigError);
  });

  it('returns a Db handle without connecting, and close() resolves', async () => {
    const handle = createDb({
      connectionString: 'postgres://user:pw@127.0.0.1:1/db',
    });
    expect(handle.db).toBeDefined();
    expect(handle.sql).toBeDefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
