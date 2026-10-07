/**
 * What a host document composer is handed (D-26): the canonical public path of
 * the page being served, and the freedom to be async. Through the real visitor
 * handler and real Postgres: the path is the cache key, a resolved composer
 * serves its own bytes, and a rejecting composer is a sealed, uncached 500.
 */
import { createHash } from 'node:crypto';
import { createMemoryCache } from '@plakboek/cache';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocumentInput } from '../../src/index.js';
import {
  createVisitorHandler,
  renderDefaultDocument,
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

let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture();
  const deps = pagesDepsFor(fixture);
  for (const page of [
    { locale: 'en', title: 'Home', text: 'Home EN', slug: 'home' },
    { locale: 'en', title: 'About', text: 'About EN', slug: 'about' },
    { locale: 'nl', title: 'Start', text: 'Home NL', slug: 'home' },
    { locale: 'nl', title: 'Over ons', text: 'Over ons', slug: 'over-ons' },
  ]) {
    await publishHeadingPage(deps, fixture.superadmin, page);
  }
});

afterAll(async () => {
  await fixture.close();
});

describe('the public path a composer receives', () => {
  it.each([
    ['/', '/'],
    ['/about', '/about'],
    ['/nl', '/nl'],
    ['/nl/over-ons', '/nl/over-ons'],
  ])('hands the composer %s as %s', async (requested, expected) => {
    const seen: DocumentInput[] = [];
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: (input) => {
        seen.push(input);
        return renderDefaultDocument(input);
      },
    });
    const response = await visit(handler, requested);
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.publicPath).toBe(expected);
  });
});

describe('an async composer', () => {
  it('serves exactly the bytes it resolved to, with an ETag over them', async () => {
    const document = '<!DOCTYPE html><html><body>async composer</body></html>';
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: async () => {
        await Promise.resolve();
        return document;
      },
    });
    const response = await visit(handler, '/about');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(document);
    const digest = createHash('sha256').update(document).digest('base64url');
    expect(response.headers.get('ETag')).toBe(`"${digest}"`);
  });

  it('turns a rejecting composer into the sealed 500, reports it once, and never caches it', async () => {
    resetRenderCounts();
    const onRenderError = vi.fn();
    let broken = true;
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache: createMemoryCache(),
      renderDocument: (input) => {
        if (broken) return Promise.reject(new Error('menu lookup failed'));
        return renderDefaultDocument(input);
      },
      hooks: { onRenderError },
    });

    const failed = await visit(handler, '/about');
    const failedBody = await failed.text();
    expect(failed.status).toBe(500);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(failedBody).not.toContain('menu lookup failed');
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError.mock.calls[0]?.[0]).toMatchObject({
      publicPath: '/about',
    });

    // Nothing was cached: once the composer recovers, the same path renders.
    broken = false;
    const recovered = await visit(handler, '/about');
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain('<h2>About EN</h2>');
    expect(renderCounts.heading).toBe(2);
  });
});

describe('a synchronous composer', () => {
  it('serves the same bytes through the default composer as before', async () => {
    const plain = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
    });
    const explicit = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      renderDocument: (input) => renderDefaultDocument(input),
    });
    const a = await (await visit(plain, '/about')).text();
    const b = await (await visit(explicit, '/about')).text();
    expect(a).toBe(b);
    expect(a).toContain('<h2>About EN</h2>');
  });
});
