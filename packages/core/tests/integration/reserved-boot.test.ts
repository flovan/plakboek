/**
 * The boot-time report of pages that already sit at a reserved address: the
 * host runtime starts it when it is first built, it keeps the pages, it goes
 * through the pages hook (the default warning here), and a failure costs one
 * line naming only the error type.
 */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { closeAllDbs } from '../../src/runtime/db.js';
import { runtimeFor } from '../../src/runtime/runtime.js';
import { createInstallation, type Installation } from './installation.js';

describe('the reserved-address report at boot', () => {
  let installation: Installation;

  beforeAll(async () => {
    installation = await createInstallation();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await installation?.dispose();
    await closeAllDbs();
  });

  /** A configuration object the runtime has not memoised yet. */
  function freshHost(): { config: Installation['runtime']['config'] } {
    return { config: { ...installation.runtime.config } };
  }

  it('flags a legacy page at /cms through the pages hook and keeps it as it was', async () => {
    const now = new Date().toISOString();
    await installation.runtime.db.sql`
      INSERT INTO pages (
        translation_group, locale, parent_page_id, slug, slug_source, path,
        title, status, version, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, 'en', NULL, 'cms', 'manual', 'cms',
        'Legacy', 'draft', 1, ${now}, ${now}
      )
    `;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    runtimeFor(freshHost());

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
    const [message] = warn.mock.calls[0] ?? [];
    expect(String(message)).toContain('cms');
    expect(String(message)).toContain('reserved');

    const kept = await installation.runtime.db.sql<
      { title: string; status: string; path: string }[]
    >`SELECT title, status, path FROM pages WHERE path = 'cms'`;
    expect(kept).toEqual([{ title: 'Legacy', status: 'draft', path: 'cms' }]);
  });

  it('does not wait for the report: building the runtime returns at once', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = runtimeFor(freshHost());
    expect(runtime.db).toBeDefined();
  });

  it('logs one line naming only the error type when the check cannot run, and never throws', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const unreachable = new URL(installation.runtime.env.databaseUrl);
    unreachable.pathname = '/plakboek_no_such_database_for_boot_check';

    expect(() =>
      runtimeFor(freshHost(), {
        DATABASE_URL: unreachable.toString(),
        PLAKBOEK_URL: 'http://localhost:3000',
        PLAKBOEK_SECRET: 'installation-test-secret-0123456789-abcdefghijk',
      }),
    ).not.toThrow();

    await vi.waitFor(() => {
      const lines = write.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes('reserved addresses failed'));
      expect(lines).toHaveLength(1);
    });
    const [line] = write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((entry) => entry.includes('reserved addresses failed'));
    expect(line).not.toContain('plakboek_no_such_database');
    expect(line).not.toContain('postgres:postgres');
    expect(line?.trimEnd().split('\n')).toHaveLength(1);
  });
});
