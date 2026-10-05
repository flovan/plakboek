/**
 * The visitor/edit seam through the real handler and real Postgres: a request
 * carrying `_edit` is routed away from the visitor cache, the renderer and the
 * database before anything else, a non-editor is bounced with a temporary
 * uncached redirect, whatever an injected edit entrypoint returns can never be
 * stored by a proxy, and every rendered page carries exactly the one inert
 * bootstrap script.
 */
import { createHash } from 'node:crypto';
import {
  createMemoryCache,
  type CacheBackend,
  type CacheEntry,
  type CacheSetOptions,
} from '@plakboek/cache';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createVisitorHandler,
  renderToolbarBootstrap,
  TOOLBAR_BOOTSTRAP_CSP_HASH,
  type EditEntrypoint,
} from '../../src/server.js';
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
  readonly calls: { ticket: number; get: number; set: number };
};

/** A memory cache that counts every call and delegates. */
function createSpyCache(): SpyCache {
  const inner = createMemoryCache();
  const calls = { ticket: 0, get: 0, set: 0 };
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
      calls.set += 1;
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

const EDITOR_HTML = '<p>editor</p>';

function nullEntrypoint(): EditEntrypoint & ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve(null));
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

describe('a request carrying _edit with no editor installed', () => {
  it('bounces with a temporary uncached redirect and touches neither the cache, the renderer nor the database', async () => {
    resetRenderCounts();
    const cache = createSpyCache();
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      cache,
    });
    const response = await visit(handler, '/about-us?_edit=1');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/about-us');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(cache.calls).toEqual({ ticket: 0, get: 0, set: 0 });
    expect(renderCounts.heading).toBe(0);
  });

  it.each([
    ['/about-us?_edit=1&utm=x', '/about-us?utm=x'],
    ['/about-us?utm=x&_edit=1', '/about-us?utm=x'],
    ['/about-us?_edit', '/about-us'],
    ['/about-us?_edit=0', '/about-us'],
    ['/about-us?a=1&_edit=1&_edit=2&b=2', '/about-us?a=1&b=2'],
    ['//evil.example/x?_edit=1', '/evil.example/x'],
  ])('%s bounces to %s', async (path, location) => {
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
    });
    const response = await visit(handler, path);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(location);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('bounces even when the page is already cached, never serving the cached 200', async () => {
    const cache = createSpyCache();
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache,
    });
    const warm = await visit(handler, '/about-us');
    expect(warm.status).toBe(200);
    await warm.text();
    const warmCalls = { ...cache.calls };

    const response = await visit(handler, '/about-us?_edit=1');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/about-us');
    expect(cache.calls).toEqual(warmCalls);
  });

  it('answers HEAD with the bounce and an empty body, and POST with 405 before the edit branch', async () => {
    const edit = nullEntrypoint();
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      edit,
    });
    const head = await visit(handler, '/about-us?_edit=1', { method: 'HEAD' });
    expect(head.status).toBe(302);
    expect(head.headers.get('Location')).toBe('/about-us');
    expect(await head.text()).toBe('');

    const post = await visit(handler, '/about-us?_edit=1', {
      method: 'POST',
      body: 'x',
    });
    expect(post.status).toBe(405);
    expect(edit).toHaveBeenCalledTimes(1);
  });
});

describe('an injected edit entrypoint', () => {
  it('that resolves null gets the same bounce and is called once with the request and the bounce location', async () => {
    const edit = nullEntrypoint();
    const cache = createSpyCache();
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      cache,
      edit,
    });
    const response = await visit(handler, '/about-us?_edit=1&utm=x');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/about-us?utm=x');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(cache.calls).toEqual({ ticket: 0, get: 0, set: 0 });

    expect(edit).toHaveBeenCalledTimes(1);
    const [request, context] = edit.mock.calls[0] as Parameters<EditEntrypoint>;
    expect(request.url).toBe('http://visitor.test/about-us?_edit=1&utm=x');
    expect(context.url.href).toBe('http://visitor.test/about-us?_edit=1&utm=x');
    expect(context.visitorLocation).toBe('/about-us?utm=x');
  });

  it('that resolves a response is returned with its status, body and headers, but never cacheable', async () => {
    resetRenderCounts();
    const cache = createSpyCache();
    const edit: EditEntrypoint = () =>
      Promise.resolve(
        new Response(EDITOR_HTML, {
          status: 200,
          headers: { 'Cache-Control': 'public, max-age=600', 'X-Editor': '1' },
        }),
      );
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      cache,
      edit,
    });
    const response = await visit(handler, '/about-us?_edit=1');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(EDITOR_HTML);
    expect(response.headers.get('X-Editor')).toBe('1');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(cache.calls).toEqual({ ticket: 0, get: 0, set: 0 });
    expect(renderCounts.heading).toBe(0);
  });

  it('has every proxy-targeted cache header stripped from the response it returned', async () => {
    const edit: EditEntrypoint = () =>
      Promise.resolve(
        new Response(EDITOR_HTML, {
          headers: {
            'Surrogate-Control': 'max-age=600',
            'CDN-Cache-Control': 'max-age=600',
            'Cloudflare-CDN-Cache-Control': 'max-age=600',
            Expires: 'Wed, 21 Oct 2037 07:28:00 GMT',
            ETag: '"editor"',
            'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
            Age: '30',
            'X-Editor': '1',
          },
        }),
      );
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      edit,
    });
    const response = await visit(handler, '/about-us?_edit=1');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Editor')).toBe('1');
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

  it('keeps a non-200 status and the status text of the response it returned', async () => {
    const edit: EditEntrypoint = () =>
      Promise.resolve(new Response('no', { status: 403 }));
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      edit,
    });
    const response = await visit(handler, '/about-us?_edit=1');
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('that throws or rejects yields the 500 path, reported once, uncacheable', async () => {
    const onRenderError = vi.fn();
    const throwing: EditEntrypoint = () => {
      throw new Error('editor exploded');
    };
    const rejecting: EditEntrypoint = () =>
      Promise.reject(new Error('editor rejected'));
    for (const edit of [throwing, rejecting]) {
      onRenderError.mockClear();
      const handler = createVisitorHandler({
        db: THROWING_DB,
        config: fixtureConfig,
        hooks: { onRenderError },
        edit,
      });
      const response = await visit(handler, '/about-us?_edit=1');
      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).not.toContain('exploded');
      expect(onRenderError).toHaveBeenCalledTimes(1);
      const [event] = onRenderError.mock.calls[0] as [
        { publicPath: string; pageId: string | null; error: unknown },
      ];
      expect(event.publicPath).toBe('/about-us');
      expect(event.pageId).toBeNull();
      expect(event.error).toBeInstanceOf(Error);
    }
  });

  it('that throws is answered by the host renderError page when one is configured', async () => {
    const handler = createVisitorHandler({
      db: THROWING_DB,
      config: fixtureConfig,
      renderError: () => new Response('host error page'),
      edit: () => Promise.reject(new Error('nope')),
    });
    const response = await visit(handler, '/about-us?_edit=1');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('host error page');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('the toolbar bootstrap on every rendered page', () => {
  function scriptsOf(html: string): string[] {
    return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] ?? '',
    );
  }

  it('is the only script, ends the body, hashes to the exported CSP hash and survives a cache hit byte for byte', async () => {
    const cache = createMemoryCache();
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache,
    });
    const first = await (await visit(handler, '/about-us')).text();
    expect(first.match(/<script/g)).toHaveLength(1);
    expect(first.endsWith(`${renderToolbarBootstrap()}</body></html>`)).toBe(
      true,
    );
    const [text] = scriptsOf(first);
    const hash = createHash('sha256')
      .update(text ?? '', 'utf8')
      .digest('base64');
    expect(`sha256-${hash}`).toBe(TOOLBAR_BOOTSTRAP_CSP_HASH);

    const second = await (await visit(handler, '/about-us')).text();
    expect(second).toBe(first);
  });

  it('is handed to a host renderDocument at the end of the body', async () => {
    const seen: string[] = [];
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: ({ body }) => {
        seen.push(body);
        return `<html><body>${body}</body></html>`;
      },
    });
    const html = await (await visit(handler, '/about-us')).text();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith(renderToolbarBootstrap())).toBe(true);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('is absent from a 404, a 405 and a redirect', async () => {
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
    });
    const missing = await visit(handler, '/missing');
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('<script');
    const redirect = await visit(handler, '/en/about-us');
    expect(redirect.status).toBe(308);
    expect(await redirect.text()).toBe('');
    const post = await visit(handler, '/about-us', {
      method: 'POST',
      body: 'x',
    });
    expect(post.status).toBe(405);
    expect(await post.text()).toBe('');
  });
});
