/**
 * The Phase 6 tracer: a host built with the real React Router build serves a
 * page published in Postgres through `cmsRoutes()`, the `plakboek()` Vite
 * plugin and `createServer()`, next to a host-owned route.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
} from '@plakboek/auth';
import { createDb, runMigrations } from '@plakboek/db';
import { createPermissionResolver } from '@plakboek/permissions';
import {
  createPage,
  getPage,
  insertBlock,
  publishPage,
  type PagesDeps,
} from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllDbs } from '../../src/runtime/db.js';
import { createServer, type RunningServer } from '../../src/server.js';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const ENV_KEYS = ['DATABASE_URL', 'PLAKBOEK_URL', 'PLAKBOEK_SECRET'] as const;

describe('Phase 6 tracer: a host app serves a published page through cmsRoutes()', () => {
  let testDatabase: TestDatabase;
  let running: RunningServer;
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });

    // The fixture config populates this process's block registry, which the
    // page engine's write paths read.
    const { default: config } =
      await import('../fixture-host/plakboek.config.ts');

    const handle = createDb({
      connectionString: testDatabase.connectionString,
    });
    try {
      const resolver = createPermissionResolver(config.roles);
      const recorder = createAuditRecorder({ db: handle.db, resolver });
      const deps: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config: config.pages,
      };
      const owner = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: SUPERADMIN_ROLE_KEY,
      });
      const actor = { userId: owner.userId, roleKey: owner.roleKey };

      const page = await createPage(deps, actor, {
        locale: 'en',
        title: 'Home',
        slug: config.homeSlug,
      });
      const target = {
        ownerType: 'page' as const,
        ownerId: page.id,
        locale: page.locale,
      };
      const section = await insertBlock(deps, actor, {
        owner: target,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: (await getPage(handle.db, page.id))?.version ?? -1,
      });
      await insertBlock(deps, actor, {
        owner: target,
        blockType: 'heading',
        parentBlockId: section.id,
        props: { text: 'Tracer works' },
        basePageVersion: (await getPage(handle.db, page.id))?.version ?? -1,
      });
      await publishPage(deps, actor, {
        pageId: page.id,
        baseVersion: (await getPage(handle.db, page.id))?.version ?? -1,
      });
    } finally {
      await handle.close();
    }

    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    process.env.DATABASE_URL = testDatabase.connectionString;
    process.env.PLAKBOEK_URL = 'http://localhost:3000';
    process.env.PLAKBOEK_SECRET =
      'tracer-test-secret-0123456789-abcdefghijklmnop';

    running = await createServer({
      buildPath: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
      port: 0,
    }).start();
  });

  afterAll(async () => {
    await running?.close();
    await closeAllDbs();
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await testDatabase?.drop();
  });

  const url = (path: string): string =>
    `http://127.0.0.1:${running.port}${path}`;

  it('serves the published page at / as server-rendered HTML with only the toolbar script', async () => {
    const response = await fetch(url('/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('Tracer works');
    expect(body.match(/<script/g)).toHaveLength(1);
  });

  it('renders a host route next to the CMS routes', async () => {
    const response = await fetch(url('/hello'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello from the host route');
  });

  it('answers an unknown path with 404', async () => {
    const response = await fetch(url('/no-such-page'));
    expect(response.status).toBe(404);
    await response.text();
  });

  it('answers HEAD / with 200 and no body', async () => {
    const response = await fetch(url('/'), { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('serves hashed assets as immutable and ships no host server code to the client', async () => {
    const hello = await (await fetch(url('/hello'))).text();
    const assetPath = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(hello)?.[0];
    expect(assetPath).toBeDefined();
    const asset = await fetch(url(assetPath ?? '/'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
    await asset.text();

    const assetsDir = join(FIXTURE_CLIENT_DIR, 'assets');
    for (const name of readdirSync(assetsDir)) {
      const source = readFileSync(join(assetsDir, name), 'utf8');
      expect(source).not.toContain('DATABASE_URL');
      expect(source).not.toContain('createVisitorHandler');
      expect(source).not.toContain('Fixture site');
    }
  });
});
