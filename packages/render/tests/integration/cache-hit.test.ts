/**
 * Cache hits, conditional requests, HEAD, concurrency and database failure
 * through the real visitor handler, with every handler given only the counting
 * database so the statement count of each request is observable.
 */
import { createMemoryCache } from '@plakboek/cache';
import { getPage, insertBlock, publishPage } from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createVisitorHandler, type VisitorHandler } from '../../src/server.js';
import { createCountingDb, type CountingDb } from './counting-db.js';
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

const PAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

let fixture: Fixture;
let counting: CountingDb;

function cachedHandler(): VisitorHandler {
  return createVisitorHandler({
    db: counting.db,
    config: fixtureConfig,
    cache: createMemoryCache(),
  });
}

/** Serves `/about-us` once so the handler's cache holds it. */
async function warm(
  handler: VisitorHandler,
  path = '/about-us',
): Promise<{ etag: string; cacheControl: string }> {
  const response = await visit(handler, path);
  expect(response.status).toBe(200);
  await response.text();
  const etag = response.headers.get('ETag');
  const cacheControl = response.headers.get('Cache-Control');
  if (etag === null || cacheControl === null) {
    throw new Error('the warm-up response carries no ETag or Cache-Control');
  }
  return { etag, cacheControl };
}

beforeAll(async () => {
  fixture = await createFixture();
  counting = createCountingDb(fixture.testDatabase.connectionString);
  const deps = pagesDepsFor(fixture);
  await publishHeadingPage(deps, fixture.superadmin, {
    locale: 'en',
    title: 'About us',
    text: 'Hello v1',
  });

  // A page whose boom block is dropped at render time: degraded, never cached.
  const broken = await publishHeadingPage(deps, fixture.superadmin, {
    locale: 'en',
    title: 'Broken',
    text: 'Still here',
    slug: 'broken',
  });
  const page = await getPage(deps.db, broken.pageId);
  if (page === null) throw new Error('page missing');
  await insertBlock(deps, fixture.superadmin, {
    owner: { ownerType: 'page', ownerId: page.id, locale: page.locale },
    blockType: 'boom',
    parentBlockId: broken.sectionId,
    basePageVersion: page.version,
  });
  const beforePublish = await getPage(deps.db, broken.pageId);
  await publishPage(deps, fixture.superadmin, {
    pageId: broken.pageId,
    baseVersion: beforePublish?.version ?? -1,
  });
});

afterAll(async () => {
  try {
    await counting.close();
  } finally {
    await fixture.close();
  }
});

describe('conditional requests on a cache hit', () => {
  it.each([
    ['the exact tag', (etag: string) => etag],
    ['a weak tag', (etag: string) => `W/${etag}`],
    ['a list containing the tag', (etag: string) => `"a", ${etag} ,"b"`],
    ['a wildcard', () => '*'],
  ])(
    'answers 304 for %s with the headers of the 200, no body and zero statements',
    async (_name, build) => {
      const handler = cachedHandler();
      const { etag, cacheControl } = await warm(handler);
      resetRenderCounts();
      counting.reset();

      const response = await visit(handler, '/about-us', {
        headers: { 'If-None-Match': build(etag) },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get('ETag')).toBe(etag);
      expect(response.headers.get('Cache-Control')).toBe(cacheControl);
      expect(await response.text()).toBe('');
      expect(counting.statements).toHaveLength(0);
      expect(renderCounts.heading).toBe(0);
    },
  );

  it('returns the full 200 for a tag that does not match', async () => {
    const handler = cachedHandler();
    await warm(handler);
    counting.reset();
    const response = await visit(handler, '/about-us', {
      headers: { 'If-None-Match': '"other"' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello v1');
    expect(counting.statements).toHaveLength(0);
  });

  it('answers 304 on a cold request after rendering, and stores the entry', async () => {
    const { etag } = await warm(cachedHandler());

    const fresh = cachedHandler();
    resetRenderCounts();
    counting.reset();
    const conditional = await visit(fresh, '/about-us', {
      headers: { 'If-None-Match': etag },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('ETag')).toBe(etag);
    expect(await conditional.text()).toBe('');
    expect(counting.statements).toHaveLength(2);
    expect(renderCounts.heading).toBe(1);

    counting.reset();
    const plain = await visit(fresh, '/about-us');
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain('Hello v1');
    expect(counting.statements).toHaveLength(0);
    expect(renderCounts.heading).toBe(1);
  });

  it('never answers 304 for a degraded page, even when the tag matches', async () => {
    const handler = cachedHandler();
    const first = await visit(handler, '/broken');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const etag = first.headers.get('ETag');
    expect(etag).not.toBeNull();
    await first.text();

    const second = await visit(handler, '/broken', {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Still here');

    const wildcard = await visit(handler, '/broken', {
      headers: { 'If-None-Match': '*' },
    });
    expect(wildcard.status).toBe(200);
    await wildcard.text();
  });
});

describe('HEAD', () => {
  it('matches GET headers on a cached page, with an empty body and zero statements', async () => {
    const handler = cachedHandler();
    const get = await visit(handler, '/about-us');
    await get.text();
    counting.reset();

    const head = await visit(handler, '/about-us', { method: 'HEAD' });
    expect(head.status).toBe(200);
    for (const name of [
      'ETag',
      'Content-Type',
      'Content-Language',
      'Cache-Control',
    ]) {
      expect([name, head.headers.get(name)]).toEqual([
        name,
        get.headers.get(name),
      ]);
      expect(head.headers.get(name)).not.toBeNull();
    }
    expect(await head.text()).toBe('');
    expect(counting.statements).toHaveLength(0);
  });

  it('fills the cache on a cold HEAD, so the following GET is a hit', async () => {
    const handler = cachedHandler();
    counting.reset();
    const head = await visit(handler, '/about-us', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(counting.statements).toHaveLength(2);

    counting.reset();
    const get = await visit(handler, '/about-us');
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('Hello v1');
    expect(counting.statements).toHaveLength(0);
  });

  it('answers 304 for a matching If-None-Match', async () => {
    const handler = cachedHandler();
    const { etag, cacheControl } = await warm(handler);
    const head = await visit(handler, '/about-us', {
      method: 'HEAD',
      headers: { 'If-None-Match': etag },
    });
    expect(head.status).toBe(304);
    expect(head.headers.get('ETag')).toBe(etag);
    expect(head.headers.get('Cache-Control')).toBe(cacheControl);
    expect(await head.text()).toBe('');
  });

  it('answers 404 with an empty body for a missing page', async () => {
    const head = await visit(cachedHandler(), '/missing', { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(head.headers.get('Cache-Control')).toBe('no-store');
    expect(await head.text()).toBe('');
  });

  it('answers 308 with an empty body for a non-canonical spelling', async () => {
    const head = await visit(cachedHandler(), '/About-Us', { method: 'HEAD' });
    expect(head.status).toBe(308);
    expect(head.headers.get('Location')).toBe('/about-us');
    expect(await head.text()).toBe('');
  });

  it('answers a GET for the same cached page with the full body', async () => {
    const handler = cachedHandler();
    const { cacheControl } = await warm(handler);
    expect(cacheControl).toBe(PAGE_CACHE_CONTROL);
    const get = await visit(handler, '/about-us');
    expect(await get.text()).toContain('Hello v1');
  });
});

describe('concurrent cold requests', () => {
  it('ten identical requests cost one render and two statements, and agree on the body', async () => {
    const handler = cachedHandler();
    resetRenderCounts();
    counting.reset();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => visit(handler, '/about-us')),
    );
    const bodies = await Promise.all(
      responses.map(async (response) => await response.text()),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('Hello v1');
    expect(renderCounts.heading).toBe(1);
    expect(counting.statements).toHaveLength(2);
  });
});

describe('a database failure on the visitor path', () => {
  it('answers an uncached 500 with no detail, reports once, and caches nothing', async () => {
    const broken = createCountingDb(fixture.testDatabase.connectionString);
    await broken.close();
    const onRenderError = vi.fn();
    const handler = createVisitorHandler({
      db: broken.db,
      config: fixtureConfig,
      cache: createMemoryCache(),
      hooks: { onRenderError },
    });

    const first = await visit(handler, '/about-us');
    const body = await first.text();
    expect(first.status).toBe(500);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(onRenderError).toHaveBeenCalledTimes(1);

    const report: unknown = onRenderError.mock.calls[0]?.[0];
    expect(report).toMatchObject({ pageId: null });
    const error = (report as { error: unknown }).error;
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.length).toBeGreaterThan(0);
    expect(body).not.toContain(message);
    expect(body).not.toMatch(/\bat \S*[/\\]\S+/);

    const second = await visit(handler, '/about-us');
    expect(second.status).toBe(500);
    expect(await second.text()).toBe(body);
    expect(onRenderError).toHaveBeenCalledTimes(2);
  });
});
