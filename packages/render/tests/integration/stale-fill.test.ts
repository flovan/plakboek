/**
 * The render-versus-publish race (ROADMAP criterion 4 under load). A memory
 * cache is wrapped so the FIRST `set` waits on a gate the test controls: the
 * render that made it started before the publish, finishes after the purge,
 * and must neither be joined by a post-purge request nor land in the cache.
 */
import {
  createMemoryCache,
  type CacheBackend,
  type CacheEntry,
  type CacheSetOptions,
} from '@plakboek/cache';
import { publishPage, updateBlockProps } from '@plakboek/pages';
import { describe, expect, it } from 'vitest';
import { createVisitorHandler } from '../../src/server.js';
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

type GatedCache = {
  readonly cache: CacheBackend;
  /** Resolves once the first `set` call has been reached. */
  readonly reached: Promise<void>;
  /** Lets the held first `set` continue. */
  release(): void;
  /** What each `set` call resolved to, in call order. */
  readonly results: boolean[];
};

/** A memory cache whose first `set` waits for `release()`. */
function createGatedCache(): GatedCache {
  const inner = createMemoryCache();
  let signalReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const results: boolean[] = [];
  let calls = 0;
  const cache: CacheBackend = {
    ticket: () => inner.ticket(),
    get: (key: string) => inner.get(key),
    purge: (tags: readonly string[]) => inner.purge(tags),
    async set(key: string, entry: CacheEntry, options: CacheSetOptions) {
      calls += 1;
      if (calls === 1) {
        signalReached();
        await gate;
      }
      const stored = await inner.set(key, entry, options);
      results.push(stored);
      return stored;
    },
  };
  return { cache, reached, release: () => release(), results };
}

/** Fails with a readable message instead of hanging the test run. */
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle`));
    }, 2000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lets in-flight requests run until they are parked on a pending promise. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

type Published = Awaited<ReturnType<typeof publishHeadingPage>>;

async function setup(): Promise<{
  readonly fixture: Fixture;
  readonly gated: GatedCache;
  readonly deps: ReturnType<typeof pagesDepsFor>;
  readonly handler: ReturnType<typeof createVisitorHandler>;
  readonly published: Published;
}> {
  resetRenderCounts();
  const fixture = await createFixture();
  const gated = createGatedCache();
  const deps = pagesDepsFor(fixture, gated.cache);
  const handler = createVisitorHandler({
    db: fixture.handle.db,
    config: fixtureConfig,
    cache: gated.cache,
  });
  const published = await publishHeadingPage(deps, fixture.superadmin, {
    locale: 'en',
    title: 'About us',
    text: 'Hello v1',
  });
  return { fixture, gated, deps, handler, published };
}

describe('a render that races a publish', () => {
  it('scenario A: a post-purge request never joins the pre-purge render and the late fill is refused', async () => {
    const { fixture, gated, deps, handler, published } = await setup();
    try {
      // R1 misses, renders v1 and parks in `set`.
      const r1 = visit(handler, '/about-us');
      await within(gated.reached, 'R1 reaching set');
      expect(renderCounts.heading).toBe(1);

      // R2 arrives before the publish and joins R1's flight: no second render.
      const r2 = visit(handler, '/about-us');
      await settle();
      expect(renderCounts.heading).toBe(1);

      // The publish commits and purges while R1 is still parked.
      await updateBlockProps(deps, fixture.superadmin, {
        blockId: published.headingId,
        baseVersion: published.headingVersion,
        props: { text: 'Hello v2' },
      });
      await publishPage(deps, fixture.superadmin, {
        pageId: published.pageId,
        baseVersion: published.pageVersion,
      });

      // R3 took its ticket after the purge: its own flight, rendering v2.
      const r3 = await within(visit(handler, '/about-us'), 'R3');
      expect(await r3.text()).toContain('<h2>Hello v2</h2>');
      expect(renderCounts.heading).toBe(2);

      // R1 finishes late: it and its follower still return v1, but its fill
      // was refused.
      gated.release();
      const first = await within(r1, 'R1');
      const second = await within(r2, 'R2');
      expect(await first.text()).toContain('<h2>Hello v1</h2>');
      expect(await second.text()).toContain('<h2>Hello v1</h2>');
      expect(gated.results).toEqual([true, false]);

      // The next visitor is a cache hit holding v2.
      const r4 = await visit(handler, '/about-us');
      expect(await r4.text()).toContain('<h2>Hello v2</h2>');
      expect(renderCounts.heading).toBe(2);
    } finally {
      gated.release();
      await fixture.close();
    }
  });

  it('scenario B: the stale fill never lands, so the next request renders the new version', async () => {
    const { fixture, gated, deps, handler, published } = await setup();
    try {
      const r1 = visit(handler, '/about-us');
      await within(gated.reached, 'R1 reaching set');
      expect(renderCounts.heading).toBe(1);

      await updateBlockProps(deps, fixture.superadmin, {
        blockId: published.headingId,
        baseVersion: published.headingVersion,
        props: { text: 'Hello v2' },
      });
      await publishPage(deps, fixture.superadmin, {
        pageId: published.pageId,
        baseVersion: published.pageVersion,
      });

      gated.release();
      const first = await within(r1, 'R1');
      expect(await first.text()).toContain('<h2>Hello v1</h2>');
      expect(gated.results).toEqual([false]);

      const next = await visit(handler, '/about-us');
      expect(await next.text()).toContain('<h2>Hello v2</h2>');
      expect(renderCounts.heading).toBe(2);
    } finally {
      gated.release();
      await fixture.close();
    }
  });

  it('without a cache two concurrent cold requests both render', async () => {
    resetRenderCounts();
    const fixture = await createFixture();
    try {
      const deps = pagesDepsFor(fixture);
      await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Hello v1',
      });
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
      });
      const responses = await Promise.all([
        visit(handler, '/about-us'),
        visit(handler, '/about-us'),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(renderCounts.heading).toBe(2);
    } finally {
      await fixture.close();
    }
  });
});
