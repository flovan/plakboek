/**
 * Runtime creation: environment validation, memoisation per config object and
 * the production-only cache. No query is run; the database is only needed to
 * build a valid connection string.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllDbs, getDb } from '../../src/runtime/db.js';
import { PlakboekEnvError } from '../../src/runtime/env.js';
import { runtimeFor } from '../../src/runtime/runtime.js';
import type { HostModule } from '../../src/types.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

describe('runtimeFor', () => {
  let testDatabase: TestDatabase;
  let host: HostModule;
  let source: Record<string, string>;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const { default: config } =
      await import('../fixture-host/plakboek.config.ts');
    host = { config };
    source = {
      DATABASE_URL: testDatabase.connectionString,
      PLAKBOEK_URL: 'http://localhost:3000',
      PLAKBOEK_SECRET: 'runtime-test-secret-0123456789-abcdefghijklmnop',
    };
  });

  afterAll(async () => {
    await closeAllDbs();
    await testDatabase?.drop();
  });

  it('returns the same runtime for the same config object and a new one for a new object', () => {
    const first = runtimeFor(host, source);
    expect(runtimeFor(host, source)).toBe(first);

    const reloaded: HostModule = { config: { ...host.config } };
    const second = runtimeFor(reloaded, source);
    expect(second).not.toBe(first);
  });

  it('reuses one database handle per connection string across runtimes', () => {
    const first = runtimeFor({ config: { ...host.config } }, source);
    const second = runtimeFor({ config: { ...host.config } }, source);
    expect(second).not.toBe(first);
    expect(second.db).toBe(first.db);
    expect(first.db).toBe(getDb(testDatabase.connectionString));
  });

  it('runs uncached outside production', () => {
    const runtime = runtimeFor(
      { config: { ...host.config } },
      { ...source, NODE_ENV: 'development' },
    );
    expect(runtime.cache).toBeUndefined();
    expect(runtime.pages.invalidator).toBeUndefined();
    expect(runtime.env.production).toBe(false);
  });

  it('backs the visitor handler and the pages invalidator with one memory cache in production', () => {
    const runtime = runtimeFor(
      { config: { ...host.config } },
      { ...source, NODE_ENV: 'production' },
    );
    expect(runtime.cache).toBeDefined();
    expect(runtime.pages.invalidator).toBe(runtime.cache);
    expect(runtime.env.production).toBe(true);
  });

  it('refuses to build without PLAKBOEK_SECRET in any NODE_ENV and does not memoise the failure', () => {
    const withoutSecret = { ...source, PLAKBOEK_SECRET: undefined };
    const reloaded: HostModule = { config: { ...host.config } };
    expect(() =>
      runtimeFor(reloaded, { ...withoutSecret, NODE_ENV: 'development' }),
    ).toThrow(PlakboekEnvError);
    expect(runtimeFor(reloaded, source)).toBeDefined();
  });

  it('does not construct mail at boot, in production without SMTP', async () => {
    const runtime = runtimeFor(
      { config: { ...host.config } },
      { ...source, NODE_ENV: 'production' },
    );
    expect(runtime.mail.describe()).toBe('unconfigured');
    await expect(
      runtime.mail.send({
        to: 'a@example.com',
        subject: 's',
        html: 'h',
        text: 't',
      }),
    ).rejects.toThrow('No SMTP server is configured');
  });
});
