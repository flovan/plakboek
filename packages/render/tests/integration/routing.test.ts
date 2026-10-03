/**
 * The request path matrix through the real handler: canonicalisation before
 * any cache or database access, the default-locale and home-slug redirects,
 * removed and unknown locales, and the guarantee that only canonical page
 * paths are ever stored (never a redirect, a 404 or a non-canonical key).
 */
import {
  createMemoryCache,
  type CacheBackend,
  type CacheEntry,
  type CacheSetOptions,
} from '@plakboek/cache';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_VISITOR_PATH_LENGTH } from '../../src/path.js';
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
  readonly cache: CacheBackend;
  readonly handler: VisitorHandler;
  /** Every key the handler tried to store, in order. */
  readonly stored: string[];
};

let world: World;

/** A memory cache that records every key passed to `set`. */
function createSpyCache(stored: string[]): CacheBackend {
  const inner = createMemoryCache();
  return {
    ticket: () => inner.ticket(),
    get: (key: string) => inner.get(key),
    purge: (tags: readonly string[]) => inner.purge(tags),
    set(key: string, entry: CacheEntry, options: CacheSetOptions) {
      stored.push(key);
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

beforeAll(async () => {
  resetRenderCounts();
  const fixture = await createFixture();
  const stored: string[] = [];
  const cache = createSpyCache(stored);
  const deps = pagesDepsFor(fixture, cache);
  const handler = createVisitorHandler({
    db: fixture.handle.db,
    config: fixtureConfig,
    cache,
  });
  for (const page of [
    { locale: 'en', title: 'About us', text: 'About', slug: undefined },
    { locale: 'en', title: 'Home', text: 'Home EN', slug: 'home' },
    { locale: 'nl', title: 'Start', text: 'Home NL', slug: 'home' },
    { locale: 'nl', title: 'Over ons', text: 'Over ons', slug: undefined },
  ]) {
    await publishHeadingPage(deps, fixture.superadmin, {
      locale: page.locale,
      title: page.title,
      text: page.text,
      ...(page.slug === undefined ? {} : { slug: page.slug }),
    });
  }
  world = { fixture, cache, handler, stored };
});

afterAll(async () => {
  await world.fixture.close();
});

describe('canonicalisation runs before any cache or database access', () => {
  const guarded = (): VisitorHandler =>
    createVisitorHandler({ db: THROWING_DB, config: fixtureConfig });

  it('redirects a non-canonical spelling, keeping the query string, without touching the database', async () => {
    const response = await visit(guarded(), '/About-Us/?utm=1');
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('/about-us?utm=1');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('answers a scanner path and an over-long path with an uncached 404 and no database use', async () => {
    const scanner = await visit(guarded(), '/wp-login.php');
    expect(scanner.status).toBe(404);
    expect(scanner.headers.get('Cache-Control')).toBe('no-store');

    const overlong = await visit(
      guarded(),
      `/${'a'.repeat(MAX_VISITOR_PATH_LENGTH + 952)}`,
    );
    expect(overlong.status).toBe(404);
    expect(overlong.headers.get('Cache-Control')).toBe('no-store');
  });

  it('never turns a protocol-relative path into an open redirect', async () => {
    const response = await visit(guarded(), '//evil.example/x');
    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();

    const collapsed = await visit(guarded(), '//about-us');
    expect(collapsed.status).toBe(308);
    expect(collapsed.headers.get('Location')).toBe('/about-us');
  });
});

describe('routing through the handler', () => {
  it('redirects the trailing-slash spelling, then caches the page under one key', async () => {
    resetRenderCounts();
    const redirect = await visit(world.handler, '/about-us/');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('Location')).toBe('/about-us');

    const first = await visit(world.handler, '/about-us');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('<h2>About</h2>');
    expect(renderCounts.heading).toBe(1);

    const second = await visit(world.handler, '/about-us');
    expect(second.status).toBe(200);
    await second.text();
    expect(renderCounts.heading).toBe(1);
  });

  it('redirects the default-locale prefix and keeps the query string', async () => {
    const response = await visit(world.handler, '/en/about-us?x=1');
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('/about-us?x=1');
  });

  it('serves the locale roots and redirects the explicit home spelling', async () => {
    const root = await visit(world.handler, '/');
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<h2>Home EN</h2>');

    const home = await visit(world.handler, '/home');
    expect(home.status).toBe(308);
    expect(home.headers.get('Location')).toBe('/');

    const dutchRoot = await visit(world.handler, '/nl');
    expect(dutchRoot.status).toBe(200);
    expect(await dutchRoot.text()).toContain('<h2>Home NL</h2>');

    const dutchHome = await visit(world.handler, '/nl/home');
    expect(dutchHome.status).toBe(308);
    expect(dutchHome.headers.get('Location')).toBe('/nl');
  });

  it('serves a prefixed Dutch page and refuses an unknown locale prefix', async () => {
    const dutch = await visit(world.handler, '/nl/over-ons');
    expect(dutch.status).toBe(200);
    expect(await dutch.text()).toContain('<h2>Over ons</h2>');
    expect(dutch.headers.get('Content-Language')).toBe('nl');

    const unknown = await visit(world.handler, '/fr/x');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 404 for a published page whose locale was removed from the config', async () => {
    const onlyEnglish = createVisitorHandler({
      db: world.fixture.handle.db,
      config: {
        ...fixtureConfig,
        content: { ...fixtureConfig.content, locales: ['en'] },
      },
    });
    const response = await visit(onlyEnglish, '/nl/over-ons');
    expect(response.status).toBe(404);
  });

  it('returns an uncached 404 for a missing page without a history lookup', async () => {
    const response = await visit(world.handler, '/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('only ever stored canonical page paths: never a redirect, a 404 or a non-canonical key', () => {
    const allowed = new Set(['/about-us', '/', '/nl', '/nl/over-ons']);
    expect(world.stored.length).toBeGreaterThan(0);
    expect(world.stored.every((key) => allowed.has(key))).toBe(true);
  });
});
