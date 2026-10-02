/**
 * The HTTP response policy of the visitor handler through the real handler
 * and real Postgres: which methods are answered, how a host-supplied not-found
 * or error response is made safe to serve to anonymous visitors, how the page
 * `Cache-Control` can be loosened for a purgeable layer, and how a cache entry
 * built by a different build is never served.
 */
import {
  createMemoryCache,
  type CacheBackend,
  type CacheEntry,
  type CacheSetOptions,
} from '@plakboek/cache';
import { getPage, insertBlock, publishPage } from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

type SpyCache = CacheBackend & {
  readonly calls: { ticket: number; get: number };
};

/** A memory cache that counts `ticket` and `get` calls and delegates. */
function createSpyCache(): SpyCache {
  const inner = createMemoryCache();
  const calls = { ticket: 0, get: 0 };
  return {
    calls,
    ticket: () => {
      calls.ticket += 1;
      return inner.ticket();
    },
    get: (key: string) => {
      calls.get += 1;
      return inner.get(key);
    },
    purge: (tags: readonly string[]) => inner.purge(tags),
    set(key: string, entry: CacheEntry, options: CacheSetOptions) {
      return inner.set(key, entry, options);
    },
  };
}

/** A database handle that fails the test run on any use. */
const THROWING_DB = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched: ${String(property)}`);
    },
  },
) as Parameters<typeof createVisitorHandler>[0]['db'];

const PAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/**
 * A document composer that throws. An error inside a block is contained to
 * that block, so the shared-render failure these tests need comes from the
 * one place outside every block.
 */
function failingDocument(): never {
  throw new Error('secret failure detail');
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture();
  const deps = pagesDepsFor(fixture);
  await publishHeadingPage(deps, fixture.superadmin, {
    locale: 'en',
    title: 'About us',
    text: 'About',
  });
});

afterAll(async () => {
  await fixture.close();
});

describe('the method gate', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    '%s answers 405 with Allow, no-store and an empty body, and never reaches the cache or the renderer',
    async (method) => {
      resetRenderCounts();
      const cache = createSpyCache();
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        cache,
      });
      const response = await visit(handler, '/about-us', {
        method,
        ...(method === 'OPTIONS' ? {} : { body: 'x' }),
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toBe('');
      expect(renderCounts.heading).toBe(0);
      expect(cache.calls).toEqual({ ticket: 0, get: 0 });
    },
  );

  it('answers 405 before any database access', async () => {
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
    });
    const response = await visit(handler, '/about-us', {
      method: 'POST',
      body: 'x',
    });
    expect(response.status).toBe(405);
  });

  it('lets GET and HEAD through to the pipeline', async () => {
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
    });
    expect((await visit(handler, '/about-us')).status).toBe(200);
    expect((await visit(handler, '/about-us', { method: 'HEAD' })).status).toBe(
      200,
    );
  });
});

describe('a host-supplied not-found response', () => {
  const hostNotFound = (): Response =>
    new Response('<h1>Gone</h1>', {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=600',
        'Content-Type': 'text/html; charset=utf-8',
        'X-Host': 'kept',
      },
    });

  it('keeps the host body and headers but forces status 404 and no-store', async () => {
    const notFound = vi.fn((_request: Request) => hostNotFound());
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache: createMemoryCache(),
      notFound,
    });
    const response = await visit(handler, '/missing');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('<h1>Gone</h1>');
    expect(response.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(response.headers.get('X-Host')).toBe('kept');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(notFound).toHaveBeenCalledWith(expect.any(Request));
  });

  it('copes with a host response whose headers are immutable', async () => {
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      notFound: () => Response.redirect('http://visitor.test/elsewhere', 302),
    });
    const response = await visit(handler, '/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('strips every proxy-targeted cache header from a host 404 as well as Cache-Control', async () => {
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      notFound: () =>
        new Response('<h1>Gone</h1>', {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=600',
            'Surrogate-Control': 'max-age=600',
            'CDN-Cache-Control': 'max-age=600',
            'Cloudflare-CDN-Cache-Control': 'max-age=600',
            Expires: 'Wed, 21 Oct 2037 07:28:00 GMT',
            ETag: '"host"',
            'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
            Age: '30',
            'X-Host': 'kept',
          },
        }),
    });
    const response = await visit(handler, '/wp-login.php');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Host')).toBe('kept');
    for (const name of [
      'Surrogate-Control',
      'CDN-Cache-Control',
      'Cloudflare-CDN-Cache-Control',
      'Expires',
      'ETag',
      'Last-Modified',
      'Age',
    ]) {
      expect([name, response.headers.get(name)]).toEqual([name, null]);
    }
  });

  it('serves the host response for a junk path rejected before the database', async () => {
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      notFound: hostNotFound,
    });
    const response = await visit(handler, '/wp-login.php');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('<h1>Gone</h1>');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('hook broke');
      },
    ],
    ['rejects', () => Promise.reject(new Error('hook rejected'))],
    ['returns something that is not a response', () => 'oops' as never],
  ])(
    'falls back to the default 404 and reports once when the hook %s',
    async (_label, notFound) => {
      const onRenderError = vi.fn();
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        notFound,
        hooks: { onRenderError },
      });
      const response = await visit(handler, '/missing');
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toContain('Not found');
      expect(onRenderError).toHaveBeenCalledTimes(1);
      expect(onRenderError.mock.calls[0]?.[0]).toMatchObject({
        publicPath: '/missing',
        pageId: null,
      });
    },
  );
});

describe('a host-supplied error response', () => {
  const hostError = (): Response =>
    new Response('<h1>Oops</h1>', {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=600' },
    });

  it('serves the host body as an uncacheable 500 and still reports the failure once', async () => {
    const onRenderError = vi.fn();
    const renderError = vi.fn((_request: Request) => hostError());
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: failingDocument,
      cache: createMemoryCache(),
      renderError,
      hooks: { onRenderError },
    });
    const response = await visit(handler, '/about-us');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('<h1>Oops</h1>');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(renderError).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default 500 when the host hook throws, with no error detail', async () => {
    const onRenderError = vi.fn();
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: failingDocument,
      renderError: () => {
        throw new Error('hook broke');
      },
      hooks: { onRenderError },
    });
    const response = await visit(handler, '/about-us');
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).not.toContain('secret failure detail');
    expect(body).not.toContain('hook broke');
    // One report for the render failure, one for the broken hook.
    expect(onRenderError).toHaveBeenCalledTimes(2);
  });

  it('gives every concurrent request its own host response while the shared failure is reported once', async () => {
    const onRenderError = vi.fn();
    const renderError = vi.fn((_request: Request) => hostError());
    const handler: VisitorHandler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: failingDocument,
      cache: createMemoryCache(),
      renderError,
      hooks: { onRenderError },
    });
    const [first, second] = await Promise.all([
      visit(handler, '/about-us'),
      visit(handler, '/about-us'),
    ]);
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(await first.text()).toBe('<h1>Oops</h1>');
    expect(await second.text()).toBe('<h1>Oops</h1>');
    expect(renderError).toHaveBeenCalledTimes(2);
    expect(onRenderError).toHaveBeenCalledTimes(1);
  });
});

describe('the default responses', () => {
  it('keeps the page 200 policy untouched', async () => {
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
    });
    const response = await visit(handler, '/about-us');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(PAGE_CACHE_CONTROL);
  });
});

describe('the page Cache-Control override', () => {
  const OVERRIDE = 'public, max-age=60, s-maxage=86400';

  it('applies to a healthy page only: degraded pages, 404s and redirects keep their fixed policies', async () => {
    const deps = pagesDepsFor(fixture);
    const boomPage = await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Boom page',
      text: 'Before the boom',
    });
    const page = await getPage(deps.db, boomPage.pageId);
    if (page === null) throw new Error('page missing');
    await insertBlock(deps, fixture.superadmin, {
      owner: { ownerType: 'page', ownerId: page.id, locale: page.locale },
      blockType: 'boom',
      parentBlockId: boomPage.sectionId,
      basePageVersion: page.version,
    });
    const withBoom = await getPage(deps.db, boomPage.pageId);
    if (withBoom === null) throw new Error('page missing');
    await publishPage(deps, fixture.superadmin, {
      pageId: boomPage.pageId,
      baseVersion: withBoom.version,
    });

    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache: createMemoryCache(),
      cacheControl: OVERRIDE,
      hooks: { onBlockRenderError: () => undefined },
    });

    const healthy = await visit(handler, '/about-us');
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get('Cache-Control')).toBe(OVERRIDE);

    // Served from the cache the second time, with the same header.
    const cached = await visit(handler, '/about-us');
    expect(cached.headers.get('Cache-Control')).toBe(OVERRIDE);

    const degraded = await visit(handler, '/boom-page');
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get('Cache-Control')).toBe('no-store');

    const missing = await visit(handler, '/missing');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('no-store');

    const redirect = await visit(handler, '/About-Us');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
});

describe('build-id staleness on cached entries', () => {
  it('re-renders an entry another build wrote and overwrites it', async () => {
    resetRenderCounts();
    const cache = createMemoryCache();
    const handlerFor = (buildId: string): VisitorHandler =>
      createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        cache,
        buildId,
      });
    const b1 = handlerFor('b1');
    const b2 = handlerFor('b2');

    await (await visit(b1, '/about-us')).text();
    expect(renderCounts.heading).toBe(1);

    // b2 misses on the entry b1 wrote, renders, and overwrites it.
    await (await visit(b2, '/about-us')).text();
    expect(renderCounts.heading).toBe(2);
    await (await visit(b2, '/about-us')).text();
    expect(renderCounts.heading).toBe(2);

    // b1 now finds b2's entry and treats it as a miss in turn.
    await (await visit(b1, '/about-us')).text();
    expect(renderCounts.heading).toBe(3);
  });

  it('stores the handler build id on the entry', async () => {
    const cache = createMemoryCache();
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache,
      buildId: 'abc123',
    });
    await (await visit(handler, '/about-us')).text();
    expect((await cache.get('/about-us'))?.buildId).toBe('abc123');
  });

  it('keeps hitting entries when no build id is set, storing null', async () => {
    resetRenderCounts();
    const cache = createMemoryCache();
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache,
    });
    await (await visit(handler, '/about-us')).text();
    await (await visit(handler, '/about-us')).text();
    expect(renderCounts.heading).toBe(1);
    expect((await cache.get('/about-us'))?.buildId).toBeNull();
  });
});
