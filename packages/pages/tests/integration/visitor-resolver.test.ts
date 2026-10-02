/**
 * `resolveVisitorPage`/`resolvePublishedPage` (05-03-PLAN.md), proven against
 * real Postgres: only published, non-draft data is reachable, editing the
 * live tree after publishing changes nothing a visitor sees, a removed locale
 * never matches, and a resolution costs at most two `select` statements that
 * never mention the working tree, the revision table or the URL history.
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
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { schedulePage, trashPage, unpublishPage } from '../../src/lifecycle.js';
import { createPage, getPage } from '../../src/pages.js';
import { setPageUrlPattern } from '../../src/page-routing.js';
import { createDraftSnapshot, publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, updateBlockProps } from '../../src/tree.js';
import {
  DEFAULT_HOME_SLUG,
  resolvePublishedPage,
  resolveVisitorPage,
  type ResolveVisitorPageInput,
  type VisitorPageResolution,
} from '../../src/visitor.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles });

const ENABLED = ['en', 'nl', 'de'] as const;

function visit(
  publicPath: string,
  locales: readonly string[] = ['en', 'nl'],
): ResolveVisitorPageInput {
  return {
    publicPath,
    locales,
    defaultLocale: 'en',
    homeSlug: DEFAULT_HOME_SLUG,
  };
}

type PageResolution = Extract<VisitorPageResolution, { kind: 'page' }>;

function asPage(result: VisitorPageResolution): PageResolution {
  if (result.kind !== 'page') {
    throw new Error(`expected a page resolution, got ${result.kind}`);
  }
  return result;
}

describe('visitor resolution (D-20..D-26)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let pool: Pool;
  let counting: AuditDatabase;
  const statements: string[] = [];
  const clock = (): Date => new Date('2026-09-25T12:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: [...ENABLED],
        defaultLocale: 'en',
        timezone: 'Europe/Brussels',
      }),
      blocks: defineBlocks([
        {
          key: 'section',
          kind: 'section',
          editor: { label: 'Section' },
          schemaVersion: 1,
          properties: {
            width: {
              fieldType: 'select',
              label: 'Width',
              options: {
                choices: [
                  { value: 'full', labels: { en: 'Full' } },
                  { value: 'contained', labels: { en: 'Contained' } },
                ],
              },
            },
          },
        },
        {
          key: 'heading',
          editor: { label: 'Heading' },
          schemaVersion: 1,
          properties: {
            text: {
              fieldType: 'short_text',
              label: 'Text',
              required: true,
              options: { maxLength: 120 },
            },
          },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 8,
    });

    const owner = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: owner.userId, roleKey: owner.roleKey };
    deps = { db, recorder, resolver, config, now: clock };

    pool = new Pool({ connectionString: testDatabase.connectionString });
    counting = drizzle(pool, {
      logger: {
        logQuery: (query: string) => {
          statements.push(query);
        },
      },
    });
  });

  afterAll(async () => {
    await pool.end();
    await handle.close();
    await testDatabase.drop();
  });

  type Fixture = {
    readonly pageId: string;
    readonly headingId: string;
    readonly headingVersion: number;
  };

  /** A page with a section holding one heading, not yet published. */
  async function draftPage(input: {
    readonly locale: string;
    readonly title: string;
    readonly slug: string;
  }): Promise<Fixture> {
    const page = await createPage(deps, actor, input);
    const owner = {
      ownerType: 'page' as const,
      ownerId: page.id,
      locale: input.locale,
    };
    const section = await insertBlock(deps, actor, {
      owner,
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'full' },
      basePageVersion: page.version,
    });
    const afterSection = await getPage(db, page.id);
    const heading = await insertBlock(deps, actor, {
      owner,
      blockType: 'heading',
      parentBlockId: section.id,
      props: { text: input.title },
      basePageVersion: afterSection?.version ?? 0,
    });
    return {
      pageId: page.id,
      headingId: heading.id,
      headingVersion: heading.version,
    };
  }

  async function publish(pageId: string) {
    const current = await getPage(db, pageId);
    return await publishPage(deps, actor, {
      pageId,
      baseVersion: current?.version ?? 0,
    });
  }

  async function publishedPage(input: {
    readonly locale: string;
    readonly title: string;
    readonly slug: string;
  }) {
    const fixture = await draftPage(input);
    const publication = await publish(fixture.pageId);
    return { ...fixture, publication };
  }

  it('resolves a published page from its bare default-locale path with the published snapshot, hash, title and SEO', async () => {
    const fixture = await draftPage({
      locale: 'en',
      title: 'About us',
      slug: 'about-us',
    });
    await handle.sql`
      UPDATE pages SET seo = ${JSON.stringify({
        title: 'SEO title',
        noindex: true,
        sitemapInclude: false,
      })}::jsonb WHERE id = ${fixture.pageId}
    `;
    const page = { ...fixture, publication: await publish(fixture.pageId) };

    const result = asPage(await resolveVisitorPage(db, visit('/about-us')));
    expect(result.publicPath).toBe('/about-us');
    expect(result.view.page).toEqual({
      id: page.pageId,
      locale: 'en',
      title: 'About us',
      resolvedPath: 'en/about-us',
      seo: {
        title: 'SEO title',
        description: null,
        imageAssetId: null,
        canonicalUrl: null,
        noindex: true,
        nofollow: false,
      },
    });
    expect(result.view.publication.id).toBe(page.publication.id);
    expect(result.view.publication.manifestHash).toBe(
      page.publication.manifestHash,
    );
    expect(result.view.publication.snapshot).toEqual(page.publication.snapshot);
    expect(Object.keys(result.view.publication).sort()).toEqual([
      'id',
      'manifestHash',
      'publishedAt',
      'snapshot',
    ]);
  });

  it('keeps the published title and SEO set when the live page row changes until the next publish', async () => {
    const page = await publishedPage({
      locale: 'en',
      title: 'Before',
      slug: 'frozen-meta',
    });
    await handle.sql`
      UPDATE pages
      SET title = 'After',
          seo = ${JSON.stringify({ title: 'Live SEO', noindex: true })}::jsonb
      WHERE id = ${page.pageId}
    `;

    const stale = asPage(await resolveVisitorPage(db, visit('/frozen-meta')));
    expect(stale.view.page.title).toBe('Before');
    expect(stale.view.page.seo.title).toBeNull();
    expect(stale.view.page.seo.noindex).toBe(false);

    await publish(page.pageId);
    const fresh = asPage(await resolveVisitorPage(db, visit('/frozen-meta')));
    expect(fresh.view.page.title).toBe('After');
    expect(fresh.view.page.seo.title).toBe('Live SEO');
    expect(fresh.view.page.seo.noindex).toBe(true);
  });

  it('serves an empty title and the default SEO set for a snapshot published before they were frozen', async () => {
    const page = await publishedPage({
      locale: 'en',
      title: 'Legacy',
      slug: 'legacy-snapshot',
    });
    await handle.sql`
      UPDATE page_publications
      SET snapshot = snapshot - 'title' - 'seo'
      WHERE id = ${page.publication.id}
    `;
    // Live values must not leak in as a substitute.
    await handle.sql`
      UPDATE pages
      SET title = 'Live only',
          seo = ${JSON.stringify({ title: 'Live SEO', noindex: true })}::jsonb
      WHERE id = ${page.pageId}
    `;

    const result = asPage(
      await resolveVisitorPage(db, visit('/legacy-snapshot')),
    );
    expect(result.view.page.title).toBe('');
    expect(result.view.page.seo).toEqual({
      title: null,
      description: null,
      imageAssetId: null,
      canonicalUrl: null,
      noindex: false,
      nofollow: false,
    });
    expect(result.view.publication.snapshot.blocks).toHaveLength(1);
  });

  it('keeps serving the published snapshot after the live tree is edited and a draft snapshot is taken', async () => {
    const page = await publishedPage({
      locale: 'en',
      title: 'Stable',
      slug: 'stable',
    });
    const before = await resolvePublishedPage(db, {
      locale: 'en',
      resolvedPath: 'en/stable',
    });

    await updateBlockProps(deps, actor, {
      blockId: page.headingId,
      baseVersion: page.headingVersion,
      props: { text: 'Edited after publishing' },
    });
    const edited = await getPage(db, page.pageId);
    await insertBlock(deps, actor, {
      owner: { ownerType: 'page', ownerId: page.pageId, locale: 'en' },
      blockType: 'section',
      parentBlockId: null,
      props: { width: 'contained' },
      basePageVersion: edited?.version ?? 0,
    });
    await createDraftSnapshot(deps, actor, { pageId: page.pageId });

    const after = asPage(await resolveVisitorPage(db, visit('/stable')));
    expect(before).not.toBeNull();
    expect(after.view.publication.manifestHash).toBe(
      page.publication.manifestHash,
    );
    expect(after.view.publication.snapshot).toEqual(page.publication.snapshot);
    expect(after.view.publication.snapshot).toEqual(
      before?.publication.snapshot,
    );
  });

  it('never resolves a draft-only, scheduled, trashed or unpublished page', async () => {
    await draftPage({ locale: 'en', title: 'Only draft', slug: 'only-draft' });
    expect(await resolveVisitorPage(db, visit('/only-draft'))).toEqual({
      kind: 'not-found',
    });

    const scheduled = await draftPage({
      locale: 'en',
      title: 'Scheduled',
      slug: 'scheduled',
    });
    const scheduledRow = await getPage(db, scheduled.pageId);
    await schedulePage(deps, actor, {
      pageId: scheduled.pageId,
      baseVersion: scheduledRow?.version ?? 0,
      scheduledAt: new Date('2026-12-01T09:00:00.000Z'),
    });
    expect(await resolveVisitorPage(db, visit('/scheduled'))).toEqual({
      kind: 'not-found',
    });

    const trashed = await publishedPage({
      locale: 'en',
      title: 'Trashed',
      slug: 'trashed',
    });
    expect((await resolveVisitorPage(db, visit('/trashed'))).kind).toBe('page');
    const trashedRow = await getPage(db, trashed.pageId);
    await trashPage(deps, actor, {
      pageId: trashed.pageId,
      baseVersion: trashedRow?.version ?? 0,
    });
    expect(await resolveVisitorPage(db, visit('/trashed'))).toEqual({
      kind: 'not-found',
    });

    const unpublished = await publishedPage({
      locale: 'en',
      title: 'Unpublished',
      slug: 'unpublished',
    });
    expect((await resolveVisitorPage(db, visit('/unpublished'))).kind).toBe(
      'page',
    );
    const unpublishedRow = await getPage(db, unpublished.pageId);
    await unpublishPage(deps, actor, {
      pageId: unpublished.pageId,
      baseVersion: unpublishedRow?.version ?? 0,
    });
    expect(await resolveVisitorPage(db, visit('/unpublished'))).toEqual({
      kind: 'not-found',
    });
  });

  it('has the database itself refuse an address on a page that is not published, so the status predicate is a second guard', async () => {
    const page = await publishedPage({
      locale: 'en',
      title: 'Status gate',
      slug: 'status-gate',
    });
    expect((await resolveVisitorPage(db, visit('/status-gate'))).kind).toBe(
      'page',
    );
    await expect(
      handle.sql`UPDATE pages SET status = 'draft' WHERE id = ${page.pageId}`,
    ).rejects.toThrow(/pages_resolved_path_check/);
  });

  it('refuses a draft snapshot even when the live pointer is aimed at it', async () => {
    const page = await publishedPage({
      locale: 'en',
      title: 'Draft pointer',
      slug: 'draft-pointer',
    });
    const draft = await createDraftSnapshot(deps, actor, {
      pageId: page.pageId,
    });
    expect((await resolveVisitorPage(db, visit('/draft-pointer'))).kind).toBe(
      'page',
    );

    await handle.sql`
      UPDATE pages SET live_publication_id = ${draft.id} WHERE id = ${page.pageId}
    `;
    expect(await resolveVisitorPage(db, visit('/draft-pointer'))).toEqual({
      kind: 'not-found',
    });
  });

  it('resolves the Dutch page under its prefix and redirects the prefixed default locale', async () => {
    const dutch = await publishedPage({
      locale: 'nl',
      title: 'Over ons',
      slug: 'over-ons',
    });

    const result = asPage(await resolveVisitorPage(db, visit('/nl/over-ons')));
    expect(result.view.page.id).toBe(dutch.pageId);
    expect(result.view.page.resolvedPath).toBe('nl/over-ons');

    expect(await resolveVisitorPage(db, visit('/en/about-us'))).toEqual({
      kind: 'redirect',
      location: '/about-us',
    });
  });

  it('serves the home page at the locale root and redirects the explicit home spelling', async () => {
    const home = await publishedPage({
      locale: 'en',
      title: 'Welcome',
      slug: 'home',
    });
    const dutchHome = await publishedPage({
      locale: 'nl',
      title: 'Welkom',
      slug: 'home',
    });

    const root = asPage(await resolveVisitorPage(db, visit('/')));
    expect(root.view.page.id).toBe(home.pageId);
    expect(root.publicPath).toBe('/');
    const dutchRoot = asPage(await resolveVisitorPage(db, visit('/nl')));
    expect(dutchRoot.view.page.id).toBe(dutchHome.pageId);
    expect(dutchRoot.publicPath).toBe('/nl');

    expect(await resolveVisitorPage(db, visit('/home'))).toEqual({
      kind: 'redirect',
      location: '/',
    });
    expect(await resolveVisitorPage(db, visit('/nl/home'))).toEqual({
      kind: 'redirect',
      location: '/nl',
    });
  });

  it('never matches a locale that is absent from the enabled list, though its rows are kept', async () => {
    const german = await publishedPage({
      locale: 'de',
      title: 'Ueber uns',
      slug: 'ueber-uns',
    });

    const enabled = asPage(
      await resolveVisitorPage(db, visit('/de/ueber-uns', ['en', 'nl', 'de'])),
    );
    expect(enabled.view.page.id).toBe(german.pageId);

    expect(
      await resolveVisitorPage(db, visit('/de/ueber-uns', ['en', 'nl'])),
    ).toEqual({ kind: 'not-found' });
  });

  it('fails closed with invalid-pattern instead of throwing when the stored pattern no longer parses', async () => {
    await publishedPage({ locale: 'en', title: 'Legacy', slug: 'legacy-url' });
    // A pattern written before literals were restricted: new writes are
    // refused by the parser, but a stored one can still be here.
    await handle.sql`UPDATE page_engine_settings SET url_pattern = '{path}.html' WHERE id = 1`;
    try {
      const result = await resolveVisitorPage(db, visit('/legacy-url'));
      expect(result.kind).toBe('invalid-pattern');
      if (result.kind !== 'invalid-pattern') throw new Error('unreachable');
      expect(result.error.issues.map((issue) => issue.code)).toEqual([
        'INVALID_LITERAL',
      ]);
      // Even junk and redirect-shaped paths answer the same, never a throw.
      expect((await resolveVisitorPage(db, visit('/en/legacy-url'))).kind).toBe(
        'invalid-pattern',
      );
      // The documented recovery: replacing the pattern through the API works
      // even though the stored one cannot be parsed.
      await setPageUrlPattern(deps, actor, { newPattern: '{locale}/{path}' });
      expect((await resolveVisitorPage(db, visit('/legacy-url'))).kind).toBe(
        'page',
      );
    } finally {
      await handle.sql`UPDATE page_engine_settings SET url_pattern = '{locale}/{path}' WHERE id = 1`;
    }
  });

  it('costs two selects for a page, one for a redirect and a malformed path, two for a miss, and never reads the working tree', async () => {
    await publishedPage({ locale: 'en', title: 'Counted', slug: 'counted' });

    const run = async (
      publicPath: string,
    ): Promise<{ kind: string; sql: string[] }> => {
      statements.length = 0;
      const result = await resolveVisitorPage(counting, visit(publicPath));
      return { kind: result.kind, sql: [...statements] };
    };

    const hit = await run('/counted');
    expect(hit.kind).toBe('page');
    expect(hit.sql).toHaveLength(2);
    // Positive control: the log is not vacuously empty.
    expect(hit.sql.some((sql) => sql.includes('"page_publications"'))).toBe(
      true,
    );

    const redirect = await run('/en/counted');
    expect(redirect.kind).toBe('redirect');
    expect(redirect.sql).toHaveLength(1);

    const malformed = await run('/counted/');
    expect(malformed.kind).toBe('not-found');
    expect(malformed.sql).toHaveLength(1);

    const miss = await run('/does-not-exist');
    expect(miss.kind).toBe('not-found');
    expect(miss.sql).toHaveLength(2);

    for (const sql of [...hit.sql, ...redirect.sql, ...miss.sql]) {
      expect(sql.trimStart().toLowerCase().startsWith('select')).toBe(true);
      expect(sql).not.toMatch(
        /page_blocks|block_revisions|page_url_history|revision_manifest|published_by/,
      );
    }
  });
});
