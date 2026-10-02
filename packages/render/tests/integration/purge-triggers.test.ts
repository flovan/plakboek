/**
 * What a visitor can observe after each live-side write (D-19, D-27): every
 * trigger is exercised through the real handler with the memory cache wired
 * as both the pages invalidator and the handler cache. Each case first GETs
 * the page so it is cached, then asserts the purge outcome, so a withheld
 * purge shows up as a stale 200.
 */
import {
  composeInvalidators,
  createMemoryCache,
  pageTag,
  type CacheInvalidator,
} from '@plakboek/cache';
import {
  deletePagePermanently,
  getPage,
  movePage,
  publishPage,
  purgeLocale,
  renamePage,
  restorePageFromTrash,
  setPageUrlPattern,
  trashPage,
  unpublishPage,
  type PagesDeps,
} from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisitorHandler, type VisitorHandler } from '../../src/server.js';
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

type World = {
  readonly fixture: Fixture;
  readonly cache: ReturnType<typeof createMemoryCache>;
  readonly deps: PagesDeps;
  readonly handler: VisitorHandler;
  /** Every tag array the pages engine purged, one entry per purge call. */
  readonly purged: string[][];
};

async function createWorld(): Promise<World> {
  resetRenderCounts();
  const fixture = await createFixture();
  const cache = createMemoryCache();
  const purged: string[][] = [];
  const spy: CacheInvalidator = {
    async purge(tags) {
      purged.push([...tags]);
    },
  };
  const deps = pagesDepsFor(fixture, composeInvalidators(cache, spy));
  const handler = createVisitorHandler({
    db: fixture.handle.db,
    config: fixtureConfig,
    cache,
  });
  return { fixture, cache, deps, handler, purged };
}

const sorted = (tags: readonly string[]): string[] => [...tags].sort();

/** The page's current version, read fresh. */
async function versionOf(world: World, pageId: string): Promise<number> {
  const page = await getPage(world.fixture.handle.db, pageId);
  if (page === null) throw new Error(`page ${pageId} vanished`);
  return page.version;
}

async function status(world: World, path: string): Promise<number> {
  return (await visit(world.handler, path)).status;
}

/** Publishes a heading page and warms the cache with one request to it. */
async function publishAndWarm(
  world: World,
  input: Parameters<typeof publishHeadingPage>[2],
  path: string,
): Promise<Awaited<ReturnType<typeof publishHeadingPage>>> {
  const published = await publishHeadingPage(
    world.deps,
    world.fixture.superadmin,
    input,
  );
  expect(await status(world, path)).toBe(200);
  world.purged.length = 0;
  return published;
}

async function republish(world: World, pageId: string): Promise<void> {
  await publishPage(world.deps, world.fixture.superadmin, {
    pageId,
    baseVersion: await versionOf(world, pageId),
  });
}

describe('per-page purge triggers, observed through the visitor handler', () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world.fixture.close();
  });

  it('unpublish: a cached page becomes 404', async () => {
    const page = await publishAndWarm(
      world,
      { locale: 'en', title: 'Unpub', text: 'Unpub body', slug: 'unpub' },
      '/unpub',
    );

    await unpublishPage(world.deps, world.fixture.superadmin, {
      pageId: page.pageId,
      baseVersion: await versionOf(world, page.pageId),
    });

    expect(world.purged).toEqual([[pageTag(page.pageId)]]);
    expect(await status(world, '/unpub')).toBe(404);
  });

  it('trash with a descendant: both cached pages become 404; restore purges them but returns to draft, and a republish serves again', async () => {
    const parent = await publishAndWarm(
      world,
      { locale: 'en', title: 'Parent', text: 'Parent body', slug: 'parent' },
      '/parent',
    );
    const child = await publishAndWarm(
      world,
      {
        locale: 'en',
        title: 'Child',
        text: 'Child body',
        slug: 'child',
        parentPageId: parent.pageId,
      },
      '/parent/child',
    );

    await trashPage(world.deps, world.fixture.superadmin, {
      pageId: parent.pageId,
      baseVersion: await versionOf(world, parent.pageId),
    });

    expect(world.purged).toHaveLength(1);
    expect(sorted(world.purged[0]!)).toEqual(
      sorted([pageTag(parent.pageId), pageTag(child.pageId)]),
    );
    expect(await status(world, '/parent')).toBe(404);
    expect(await status(world, '/parent/child')).toBe(404);

    world.purged.length = 0;
    await restorePageFromTrash(world.deps, world.fixture.superadmin, {
      pageId: parent.pageId,
      baseVersion: await versionOf(world, parent.pageId),
    });

    expect(world.purged).toHaveLength(1);
    expect(sorted(world.purged[0]!)).toEqual(
      sorted([pageTag(parent.pageId), pageTag(child.pageId)]),
    );
    expect(await status(world, '/parent')).toBe(404);

    await republish(world, parent.pageId);
    expect(await status(world, '/parent')).toBe(200);
  });

  it('permanent delete: a cached page becomes 404', async () => {
    const page = await publishAndWarm(
      world,
      { locale: 'en', title: 'Doomed', text: 'Doomed body', slug: 'doomed' },
      '/doomed',
    );

    await deletePagePermanently(world.deps, world.fixture.superadmin, {
      pageId: page.pageId,
      baseVersion: await versionOf(world, page.pageId),
    });

    expect(world.purged).toEqual([[pageTag(page.pageId)]]);
    expect(await status(world, '/doomed')).toBe(404);
  });

  it('move with a descendant: old and new URLs 404 until each page is republished (D-27)', async () => {
    const moved = await publishAndWarm(
      world,
      { locale: 'en', title: 'A', text: 'A body', slug: 'a' },
      '/a',
    );
    const movedChild = await publishAndWarm(
      world,
      {
        locale: 'en',
        title: 'C',
        text: 'C body',
        slug: 'c',
        parentPageId: moved.pageId,
      },
      '/a/c',
    );
    const target = await publishAndWarm(
      world,
      { locale: 'en', title: 'B', text: 'B body', slug: 'b' },
      '/b',
    );

    await movePage(world.deps, world.fixture.superadmin, {
      pageId: moved.pageId,
      baseVersion: await versionOf(world, moved.pageId),
      newParentPageId: target.pageId,
    });

    expect(world.purged).toHaveLength(1);
    expect(sorted(world.purged[0]!)).toEqual(
      sorted([pageTag(moved.pageId), pageTag(movedChild.pageId)]),
    );
    expect(await status(world, '/a')).toBe(404);
    expect(await status(world, '/a/c')).toBe(404);
    expect(await status(world, '/b/a')).toBe(404);
    expect(await status(world, '/b/a/c')).toBe(404);
    expect(await status(world, '/b')).toBe(200);

    await republish(world, moved.pageId);
    expect(await status(world, '/b/a')).toBe(200);
    expect(await status(world, '/b/a/c')).toBe(404);
    expect(await status(world, '/a')).toBe(404);

    await republish(world, movedChild.pageId);
    expect(await status(world, '/b/a/c')).toBe(200);
  });

  it('slug rename: the old and new URLs 404 until the page is republished (D-27)', async () => {
    const page = await publishAndWarm(
      world,
      { locale: 'en', title: 'Old', text: 'Old body', slug: 'old-slug' },
      '/old-slug',
    );

    await renamePage(world.deps, world.fixture.superadmin, {
      pageId: page.pageId,
      baseVersion: await versionOf(world, page.pageId),
      slug: 'new-slug',
    });

    expect(world.purged).toEqual([[pageTag(page.pageId)]]);
    expect(await status(world, '/old-slug')).toBe(404);
    expect(await status(world, '/new-slug')).toBe(404);

    await republish(world, page.pageId);
    expect(await status(world, '/new-slug')).toBe(200);
    expect(await status(world, '/old-slug')).toBe(404);
  });

  it('title-only rename: the cached page keeps serving but carries the new title after a re-render', async () => {
    const page = await publishAndWarm(
      world,
      { locale: 'en', title: 'Before', text: 'Title body', slug: 'retitle' },
      '/retitle',
    );
    const cachedBody = await (await visit(world.handler, '/retitle')).text();
    expect(cachedBody).toContain('Before');
    const rendersBefore = renderCounts.heading;

    await renamePage(world.deps, world.fixture.superadmin, {
      pageId: page.pageId,
      baseVersion: await versionOf(world, page.pageId),
      title: 'After',
    });

    expect(world.purged).toEqual([[pageTag(page.pageId)]]);
    const response = await visit(world.handler, '/retitle');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<title>After</title>');
    expect(body).not.toContain('Before');
    expect(renderCounts.heading).toBe(rendersBefore + 1);
  });
});

describe('global purge triggers, each in its own database', () => {
  it('a URL-pattern change stops the old public URLs and serves the new ones', async () => {
    const world = await createWorld();
    try {
      await publishAndWarm(
        world,
        { locale: 'en', title: 'About us', text: 'About', slug: 'about-us' },
        '/about-us',
      );
      await publishAndWarm(
        world,
        { locale: 'nl', title: 'Over ons', text: 'Over', slug: 'over-ons' },
        '/nl/over-ons',
      );

      await setPageUrlPattern(world.deps, world.fixture.superadmin, {
        newPattern: 'site/{locale}/{path}',
      });

      expect(world.purged).toEqual([['global']]);
      expect(await status(world, '/about-us')).toBe(404);
      expect(await status(world, '/nl/over-ons')).toBe(404);
      expect(await status(world, '/site/about-us')).toBe(200);
      expect(await status(world, '/site/nl/over-ons')).toBe(200);
    } finally {
      await world.fixture.close();
    }
  });

  it('a locale purge makes the locale unserved and purges global', async () => {
    const world = await createWorld();
    try {
      await publishAndWarm(
        world,
        { locale: 'nl', title: 'Over ons', text: 'Over', slug: 'over-ons' },
        '/nl/over-ons',
      );
      // The handler keeps the full config (both locales enabled), so the 404
      // can only come from the purge plus the deleted rows.
      const narrowed: PagesDeps = {
        ...world.deps,
        config: {
          ...fixtureConfig,
          content: { ...fixtureConfig.content, locales: ['en'] },
        },
      };

      await purgeLocale(narrowed, world.fixture.superadmin, { locale: 'nl' });

      expect(world.purged).toEqual([['global']]);
      expect(await status(world, '/nl/over-ons')).toBe(404);
    } finally {
      await world.fixture.close();
    }
  });
});
