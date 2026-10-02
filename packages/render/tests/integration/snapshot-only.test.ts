/**
 * ROADMAP criterion 3, proven with an instrumented database against real
 * Postgres: a visitor request issues two plain selects over three tables,
 * reads only published-safe columns, never writes or locks, and is blind to
 * live edits, drafts and pages that are not published.
 *
 * The handler under test is given ONLY the counting database, and a positive
 * control asserts its log is non-empty and names `page_publications`, so the
 * rules below cannot pass over an empty log.
 */
import { createMemoryCache } from '@plakboek/cache';
import {
  createDraftSnapshot,
  createPage,
  getPage,
  insertBlock,
  schedulePage,
  trashPage,
  unpublishPage,
  updateBlockProps,
} from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisitorHandler, type VisitorHandler } from '../../src/server.js';
import {
  createCountingDb,
  qualifiedColumns,
  tablesTouched,
  type CountingDb,
} from './counting-db.js';
import {
  createFixture,
  fixtureConfig,
  pagesDepsFor,
  publishHeadingPage,
  renderCounts,
  resetRenderCounts,
  visit,
  type Fixture,
} from './fixtures.js';

const ALLOWED_TABLES = ['pages', 'page_publications', 'page_engine_settings'];
const ALLOWED_PAGES_COLUMNS = [
  'id',
  'locale',
  'title',
  'resolved_path',
  'seo',
  'status',
  'live_publication_id',
];
const ALLOWED_PUBLICATION_COLUMNS = [
  'id',
  'manifest_hash',
  'published_at',
  'snapshot',
  'is_draft',
];

/** The rules every statement on the visitor path must meet (D-21). */
function expectVisitorRules(statements: readonly string[]): void {
  for (const statement of statements) {
    const sql = statement.trim().toLowerCase();
    expect(sql.startsWith('select ')).toBe(true);
    expect(sql).not.toMatch(
      /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/,
    );
    expect(sql).not.toMatch(/\b(?:insert|update|delete)\b/);
  }
  const tables = tablesTouched(statements);
  for (const table of tables) expect(ALLOWED_TABLES).toContain(table);

  const columns = qualifiedColumns(statements);
  for (const column of columns.get('pages') ?? []) {
    expect(ALLOWED_PAGES_COLUMNS).toContain(column);
  }
  for (const column of columns.get('page_publications') ?? []) {
    expect(ALLOWED_PUBLICATION_COLUMNS).toContain(column);
  }
  for (const statement of statements) {
    expect(statement).not.toContain('revision_manifest');
    expect(statement).not.toContain('published_by');
  }
}

let fixture: Fixture;
let counting: CountingDb;

function cachelessHandler(): VisitorHandler {
  return createVisitorHandler({ db: counting.db, config: fixtureConfig });
}

beforeAll(async () => {
  fixture = await createFixture();
  counting = createCountingDb(fixture.testDatabase.connectionString);
  await publishHeadingPage(pagesDepsFor(fixture), fixture.superadmin, {
    locale: 'en',
    title: 'About us',
    text: 'Hello v1',
  });
});

afterAll(async () => {
  try {
    await counting.close();
  } finally {
    await fixture.close();
  }
});

describe('a cold visitor request (ROADMAP criterion 3, D-07, D-21)', () => {
  it('logs exactly two selects, and the log is not vacuously empty', async () => {
    counting.reset();
    const response = await visit(cachelessHandler(), '/about-us');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello v1');

    // Positive control: an empty log would satisfy every rule below.
    expect(counting.statements.length).toBeGreaterThan(0);
    expect(
      counting.statements.some((sql) => sql.includes('"page_publications"')),
    ).toBe(true);
    expect(counting.statements).toHaveLength(2);
    expectVisitorRules(counting.statements);
  });

  it('touches exactly the three tables and nothing from the working tree', async () => {
    counting.reset();
    await visit(cachelessHandler(), '/about-us');
    expect([...tablesTouched(counting.statements)].sort()).toEqual(
      [...ALLOWED_TABLES].sort(),
    );
    const columns = qualifiedColumns(counting.statements);
    expect([...(columns.get('pages') ?? [])].sort()).toEqual(
      [...ALLOWED_PAGES_COLUMNS].sort(),
    );
    expect([...(columns.get('page_publications') ?? [])].sort()).toEqual(
      [...ALLOWED_PUBLICATION_COLUMNS].sort(),
    );
  });
});

describe('the published snapshot is all a visitor sees', () => {
  it('serves the published content after live edits and a draft snapshot, through the same rules', async () => {
    const deps = pagesDepsFor(fixture);
    const published = await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Stable',
      text: 'Hello v1',
      slug: 'stable',
    });

    // Cache v1 first: the later uncached render must still not see the edits.
    const cached = createVisitorHandler({
      db: counting.db,
      config: fixtureConfig,
      cache: createMemoryCache(),
    });
    expect(await (await visit(cached, '/stable')).text()).toContain('Hello v1');

    await updateBlockProps(deps, fixture.superadmin, {
      blockId: published.headingId,
      baseVersion: published.headingVersion,
      props: { text: 'Edited after publishing' },
    });
    const edited = await getPage(deps.db, published.pageId);
    await insertBlock(deps, fixture.superadmin, {
      owner: { ownerType: 'page', ownerId: published.pageId, locale: 'en' },
      blockType: 'heading',
      parentBlockId: published.sectionId,
      props: { text: 'Inserted after publishing' },
      basePageVersion: edited?.version ?? -1,
    });
    await createDraftSnapshot(deps, fixture.superadmin, {
      pageId: published.pageId,
    });

    counting.reset();
    const response = await visit(cachelessHandler(), '/stable');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Hello v1');
    expect(html).not.toContain('Edited after publishing');
    expect(html).not.toContain('Inserted after publishing');
    expect(counting.statements.length).toBeGreaterThan(0);
    expectVisitorRules(counting.statements);
  });

  it('answers 404 for a draft-only, scheduled, unpublished and trashed page, through the same rules', async () => {
    const deps = pagesDepsFor(fixture);
    const actor = fixture.superadmin;

    await createPage(deps, actor, {
      locale: 'en',
      title: 'Only draft',
      slug: 'only-draft',
    });

    const scheduled = await createPage(deps, actor, {
      locale: 'en',
      title: 'Scheduled',
      slug: 'scheduled',
    });
    await schedulePage(deps, actor, {
      pageId: scheduled.id,
      baseVersion: scheduled.version,
      scheduledAt: new Date('2026-12-01T09:00:00.000Z'),
    });

    const unpublished = await publishHeadingPage(deps, actor, {
      locale: 'en',
      title: 'Unpublished',
      text: 'Gone',
      slug: 'unpublished',
    });
    await unpublishPage(deps, actor, {
      pageId: unpublished.pageId,
      baseVersion: unpublished.pageVersion,
    });

    const trashed = await publishHeadingPage(deps, actor, {
      locale: 'en',
      title: 'Trashed',
      text: 'Gone',
      slug: 'trashed',
    });
    await trashPage(deps, actor, {
      pageId: trashed.pageId,
      baseVersion: trashed.pageVersion,
    });

    for (const path of [
      '/only-draft',
      '/scheduled',
      '/unpublished',
      '/trashed',
    ]) {
      counting.reset();
      const response = await visit(cachelessHandler(), path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(counting.statements.length).toBeGreaterThan(0);
      expectVisitorRules(counting.statements);
    }
  });
});

describe('a repeat request (ROADMAP criterion 2, INFRA-01, D-07)', () => {
  it('is served from the cache with zero statements, one render and the same bytes and ETag', async () => {
    resetRenderCounts();
    const handler = createVisitorHandler({
      db: counting.db,
      config: fixtureConfig,
      cache: createMemoryCache(),
    });

    counting.reset();
    const first = await visit(handler, '/about-us');
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    expect(counting.statements).toHaveLength(2);
    expect(renderCounts.heading).toBe(1);

    counting.reset();
    const second = await visit(handler, '/about-us');
    const secondBody = await second.text();
    expect(counting.statements).toHaveLength(0);
    expect(renderCounts.heading).toBe(1);
    expect(secondBody).toBe(firstBody);
    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
    expect(first.headers.get('ETag')).not.toBeNull();
  });
});
