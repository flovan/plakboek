/**
 * The Phase 5 tracer: one production-quality path through every layer. A
 * host config with fixture blocks, a published page, a visitor request
 * through `createVisitorHandler` that misses the cache and renders the
 * published snapshot, a second request served from the cache with no render,
 * a live-tree edit that changes nothing for the visitor, and a second
 * publish that purges the page after commit so the next visitor gets the new
 * version.
 */
import { createMemoryCache } from '@plakboek/cache';
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
} from './fixtures.js';

describe('Phase 5 tracer: a visitor gets the published page from cache, and a publish purges it', () => {
  it('serves, caches, ignores live edits and purges on publish through one handler', async () => {
    resetRenderCounts();
    const fixture = await createFixture();
    try {
      const cache = createMemoryCache();
      const deps = pagesDepsFor(fixture, cache);
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        cache,
      });

      const published = await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Hello v1',
      });

      const first = await visit(handler, '/about-us');
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(firstBody.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(firstBody).toContain('<html lang="en">');
      expect(firstBody).toContain('<title>About us</title>');
      expect(firstBody).toContain('<h2>Hello v1</h2>');
      expect(firstBody).not.toMatch(/ data-/);
      expect(firstBody).not.toContain('<script');
      expect(first.headers.get('Content-Type')).toBe(
        'text/html; charset=utf-8',
      );
      expect(first.headers.get('Content-Language')).toBe('en');
      expect(first.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(first.headers.get('Cache-Control')).toBe(
        'public, max-age=0, must-revalidate',
      );
      const etag = first.headers.get('ETag');
      expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(renderCounts.heading).toBe(1);

      // A repeat request and one with a query string are cache hits: same
      // bytes, same validator, no second render.
      const second = await visit(handler, '/about-us');
      const withQuery = await visit(handler, '/about-us?utm_source=x');
      expect(await second.text()).toBe(firstBody);
      expect(await withQuery.text()).toBe(firstBody);
      expect(second.headers.get('ETag')).toBe(etag);
      expect(withQuery.headers.get('ETag')).toBe(etag);
      expect(renderCounts.heading).toBe(1);

      // Editing the live tree changes nothing a visitor receives.
      await updateBlockProps(deps, fixture.superadmin, {
        blockId: published.headingId,
        baseVersion: published.headingVersion,
        props: { text: 'Hello v2' },
      });
      const afterEdit = await visit(handler, '/about-us');
      expect(await afterEdit.text()).toContain('<h2>Hello v1</h2>');

      // A publish purges the page after commit; the next visitor renders v2.
      await publishPage(deps, fixture.superadmin, {
        pageId: published.pageId,
        baseVersion: published.pageVersion,
      });
      const afterPublish = await visit(handler, '/about-us');
      const afterPublishBody = await afterPublish.text();
      expect(afterPublishBody).toContain('<h2>Hello v2</h2>');
      expect(afterPublishBody).not.toContain('Hello v1');
      expect(afterPublish.headers.get('ETag')).not.toBe(etag);
      expect(renderCounts.heading).toBe(2);

      // The prefixed spelling of the default locale redirects to the bare one.
      const prefixed = await visit(handler, '/en/about-us?ref=1');
      expect(prefixed.status).toBe(308);
      expect(prefixed.headers.get('Location')).toBe('/about-us?ref=1');

      const missing = await visit(handler, '/missing');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('Cache-Control')).toBe('no-store');

      // A handler built without a cache renders every request, while the
      // first handler keeps serving from its own cache.
      const uncached = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
      });
      const before = renderCounts.heading;
      await (await visit(uncached, '/about-us')).text();
      await (await visit(uncached, '/about-us')).text();
      expect(renderCounts.heading).toBe(before + 2);
      await (await visit(handler, '/about-us')).text();
      expect(renderCounts.heading).toBe(before + 2);
    } finally {
      await fixture.close();
    }
  });
});
