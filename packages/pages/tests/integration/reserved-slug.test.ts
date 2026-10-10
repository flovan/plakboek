/**
 * Reserved first address segments (Phase 7 D-23), proven against real
 * Postgres: no write can put a page at `/cms...` or `/api...`, a generated
 * slug steps over them, and a legacy page that already collides is kept and
 * flagged, never deleted, rewritten or thrown over.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage, getPage, movePage, renamePage } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import {
  checkReservedPagePaths,
  reportReservedPagePaths,
  ReservedPageSlugError,
  type ReservedPagePathEvent,
} from '../../src/reserved.js';
import { createPageTranslation } from '../../src/translations.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles });

describe('reserved first page-address segments (D-23)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const clock = (): Date => new Date('2026-10-10T12:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: defineBlocks([
        {
          key: 'hero',
          editor: { label: 'Hero' },
          schemaVersion: 1,
          properties: {},
        },
      ]),
    });
    const owner = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: owner.userId, roleKey: owner.roleKey };
    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  async function counts(): Promise<{ pages: number; audit: number }> {
    const [pageRow] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pages
    `;
    const [auditRow] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
    `;
    return {
      pages: Number(pageRow?.count ?? 0),
      audit: Number(auditRow?.count ?? 0),
    };
  }

  it('refuses a manual root slug of cms or api and writes nothing', async () => {
    const before = await counts();
    for (const slug of ['cms', 'api']) {
      const error: unknown = await createPage(deps, actor, {
        locale: 'en',
        title: 'Reserved',
        slug,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReservedPageSlugError);
      expect((error as ReservedPageSlugError).segment).toBe(slug);
    }
    expect(await counts()).toEqual(before);
  });

  it('gives a generated root slug of cms the next free suffix', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'CMS',
    });
    expect(page.slug).toBe('cms-2');
    expect(page.slugSource).toBe('generated');

    const api = await createPage(deps, actor, { locale: 'en', title: 'API' });
    expect(api.slug).toBe('api-2');
    const again = await createPage(deps, actor, { locale: 'en', title: 'API' });
    expect(again.slug).toBe('api-3');
  });

  it('allows the same word below another page and as a longer first segment', async () => {
    const docs = await createPage(deps, actor, {
      locale: 'en',
      title: 'Docs',
      slug: 'docs',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'CMS',
      slug: 'cms',
      parentPageId: docs.id,
    });
    expect(child.path).toBe('docs/cms');

    const generatedChild = await createPage(deps, actor, {
      locale: 'en',
      title: 'API',
      parentPageId: docs.id,
    });
    expect(generatedChild.slug).toBe('api');

    const longer = await createPage(deps, actor, {
      locale: 'en',
      title: 'Cmsx',
      slug: 'cmsx',
    });
    expect(longer.path).toBe('cmsx');
  });

  it('refuses renaming a root page to a reserved slug, and allows it for a child', async () => {
    const root = await createPage(deps, actor, {
      locale: 'en',
      title: 'Rename me',
      slug: 'rename-me',
    });
    const before = await counts();
    const error: unknown = await renamePage(deps, actor, {
      pageId: root.id,
      baseVersion: root.version,
      slug: 'api',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReservedPageSlugError);
    expect(await counts()).toEqual(before);
    expect((await getPage(db, root.id))?.slug).toBe('rename-me');

    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Parent',
      slug: 'parent',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Child',
      slug: 'child',
      parentPageId: parent.id,
    });
    const renamed = await renamePage(deps, actor, {
      pageId: child.id,
      baseVersion: child.version,
      slug: 'api',
    });
    expect(renamed.path).toBe('parent/api');
  });

  it('refuses moving a child whose slug is reserved to the root', async () => {
    const parent = await createPage(deps, actor, {
      locale: 'en',
      title: 'Holder',
      slug: 'holder',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Hidden',
      slug: 'cms',
      parentPageId: parent.id,
    });
    const before = await counts();
    const error: unknown = await movePage(deps, actor, {
      pageId: child.id,
      baseVersion: child.version,
      newParentPageId: null,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReservedPageSlugError);
    expect(await counts()).toEqual(before);
    expect((await getPage(db, child.id))?.path).toBe('holder/cms');
  });

  it('refuses a root translation with a reserved manual slug', async () => {
    const source = await createPage(deps, actor, {
      locale: 'en',
      title: 'Translate me',
      slug: 'translate-me',
    });
    const before = await counts();
    const error: unknown = await createPageTranslation(deps, actor, {
      pageId: source.id,
      locale: 'nl',
      slug: 'cms',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReservedPageSlugError);
    expect(await counts()).toEqual(before);

    const ok = await createPageTranslation(deps, actor, {
      pageId: source.id,
      locale: 'nl',
      slug: 'vertaal-mij',
    });
    expect(ok.path).toBe('vertaal-mij');
  });

  it('flags a legacy page without touching it, and reports each row', async () => {
    expect(await checkReservedPagePaths(db)).toEqual([]);

    const now = clock().toISOString();
    const legacyGroup = randomUUID();
    const [legacy] = await handle.sql<{ id: string }[]>`
      INSERT INTO pages (
        translation_group, locale, parent_page_id, slug, slug_source, path,
        title, status, version, created_at, updated_at
      ) VALUES (
        ${legacyGroup}, 'en', NULL, 'cms', 'manual', 'cms',
        'Legacy', 'draft', 1, ${now}, ${now}
      ) RETURNING id
    `;
    const [legacyChild] = await handle.sql<{ id: string }[]>`
      INSERT INTO pages (
        translation_group, locale, parent_page_id, slug, slug_source, path,
        title, status, version, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, 'nl', NULL, 'api', 'manual', 'api/oud',
        'Oud', 'trashed', 1, ${now}, ${now}
      ) RETURNING id
    `;
    if (legacy === undefined || legacyChild === undefined) {
      throw new Error('raw insert returned no row');
    }
    const before = await counts();

    const rows = await checkReservedPagePaths(db);
    expect(rows).toEqual([
      { pageId: legacy.id, locale: 'en', path: 'cms', segment: 'cms' },
      {
        pageId: legacyChild.id,
        locale: 'nl',
        path: 'api/oud',
        segment: 'api',
      },
    ]);

    const events: ReservedPagePathEvent[] = [];
    reportReservedPagePaths(
      {
        hooks: { onReservedPagePath: (event) => events.push(event) },
        now: clock,
      },
      rows,
    );
    expect(events.map((event) => event.pageId)).toEqual([
      legacy.id,
      legacyChild.id,
    ]);
    expect(events[0]?.occurredAt).toEqual(clock());

    // Keep data: nothing was deleted, renamed or written by check or report.
    expect(await counts()).toEqual(before);
    expect((await getPage(db, legacy.id))?.path).toBe('cms');

    // An unchanged legacy root page may still be edited without a refusal
    // (only a change that reaches a reserved segment is refused).
    const stillThere = await getPage(db, legacy.id);
    const renamed = await renamePage(deps, actor, {
      pageId: legacy.id,
      baseVersion: stillThere?.version ?? 0,
      title: 'Legacy, retitled',
    });
    expect(renamed.path).toBe('cms');
  });
});
