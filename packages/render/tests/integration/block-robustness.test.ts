/**
 * The block robustness policy (D-14, D-29) through the real visitor handler
 * and real Postgres: a throwing block is dropped, reported and never cached;
 * a block type missing from the running config renders nothing and stays
 * cacheable; an error raised below a block's own call fails the render as an
 * uncached 500 with no error detail in the body.
 */
import { createMemoryCache } from '@plakboek/cache';
import {
  getPage,
  insertBlock,
  publishPage,
  type BlockDefinition,
  type PagesDeps,
} from '@plakboek/pages';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AuditActor } from '@plakboek/auth';
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

const PAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Appends a block under a section and returns nothing; versions are read live. */
async function appendBlock(
  deps: PagesDeps,
  actor: AuditActor,
  input: {
    readonly pageId: string;
    readonly sectionId: string;
    readonly blockType: string;
    readonly props?: Record<string, unknown>;
  },
): Promise<void> {
  const page = await getPage(deps.db, input.pageId);
  if (page === null) throw new Error('page missing');
  await insertBlock(deps, actor, {
    owner: { ownerType: 'page', ownerId: page.id, locale: page.locale },
    blockType: input.blockType,
    parentBlockId: input.sectionId,
    ...(input.props === undefined ? {} : { props: input.props }),
    basePageVersion: page.version,
  });
}

async function republish(
  deps: PagesDeps,
  actor: AuditActor,
  pageId: string,
): Promise<void> {
  const page = await getPage(deps.db, pageId);
  if (page === null) throw new Error('page missing');
  await publishPage(deps, actor, { pageId, baseVersion: page.version });
}

function withBlocks(blocks: readonly BlockDefinition[]): typeof fixtureConfig {
  return { ...fixtureConfig, blocks };
}

describe('block robustness through the visitor handler', () => {
  it('drops a throwing block, serves the page uncached, and renders again on the next request', async () => {
    resetRenderCounts();
    const fixture = await createFixture();
    try {
      const deps = pagesDepsFor(fixture);
      const published = await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Heading A',
      });
      await appendBlock(deps, fixture.superadmin, {
        pageId: published.pageId,
        sectionId: published.sectionId,
        blockType: 'boom',
      });
      await appendBlock(deps, fixture.superadmin, {
        pageId: published.pageId,
        sectionId: published.sectionId,
        blockType: 'heading',
        props: { text: 'Heading B' },
      });
      await republish(deps, fixture.superadmin, published.pageId);

      const onBlockRenderError = vi.fn();
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        cache: createMemoryCache(),
        hooks: { onBlockRenderError },
      });

      resetRenderCounts();
      const first = await visit(handler, '/about-us');
      const body = await first.text();
      expect(first.status).toBe(200);
      expect(body).toContain('<h2>Heading A</h2>');
      expect(body).toContain('<h2>Heading B</h2>');
      expect(body).not.toContain('boom');
      expect(first.headers.get('Cache-Control')).toBe('no-store');
      expect(onBlockRenderError).toHaveBeenCalledTimes(1);
      expect(onBlockRenderError.mock.calls[0]?.[0]).toMatchObject({
        blockType: 'boom',
        pageId: published.pageId,
      });
      const rendersAfterFirst = renderCounts.heading;
      expect(rendersAfterFirst).toBe(2);

      // Never cached: the second request renders the headings again.
      const second = await visit(handler, '/about-us');
      expect(second.status).toBe(200);
      expect(await second.text()).toBe(body);
      expect(renderCounts.heading).toBe(rendersAfterFirst + 2);
      expect(onBlockRenderError).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.close();
    }
  });

  it('renders nothing for a block type missing from the config and keeps the page cacheable', async () => {
    resetRenderCounts();
    const fixture = await createFixture();
    try {
      const deps = pagesDepsFor(fixture);
      const published = await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Hello',
      });
      const onUnknownBlock = vi.fn();
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: withBlocks(
          fixtureConfig.blocks.filter(
            (definition) => definition.key !== 'heading',
          ),
        ),
        cache: createMemoryCache(),
        hooks: { onUnknownBlock },
      });

      const first = await visit(handler, '/about-us');
      const body = await first.text();
      expect(first.status).toBe(200);
      expect(body).toContain('<section>');
      expect(body).not.toContain('Hello');
      expect(first.headers.get('Cache-Control')).toBe(PAGE_CACHE_CONTROL);
      expect(onUnknownBlock).toHaveBeenCalledTimes(1);
      expect(onUnknownBlock.mock.calls[0]?.[0]).toMatchObject({
        blockType: 'heading',
        blockId: published.headingId,
        pageId: published.pageId,
      });

      // Cacheable: a second request is a cache hit and reports nothing new.
      const second = await visit(handler, '/about-us');
      expect(await second.text()).toBe(body);
      expect(onUnknownBlock).toHaveBeenCalledTimes(1);
      expect(renderCounts.heading).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('turns an error below a block into an uncached 500 with no error detail', async () => {
    const fixture = await createFixture();
    try {
      const deps = pagesDepsFor(fixture);
      const published = await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Hello',
      });
      const Thrower = (): never => {
        throw new Error('secret failure detail');
      };
      const onRenderError = vi.fn();
      const onBlockRenderError = vi.fn();
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: withBlocks(
          fixtureConfig.blocks.map((definition) =>
            definition.key === 'heading'
              ? { ...definition, component: () => createElement(Thrower) }
              : definition,
          ),
        ),
        cache: createMemoryCache(),
        hooks: { onRenderError, onBlockRenderError },
      });

      const first = await visit(handler, '/about-us');
      const body = await first.text();
      expect(first.status).toBe(500);
      expect(first.headers.get('Cache-Control')).toBe('no-store');
      expect(body).not.toContain('secret failure detail');
      expect(body).not.toMatch(/\bat\s+\S+\s*\(/);
      expect(onRenderError).toHaveBeenCalledTimes(1);
      expect(onRenderError.mock.calls[0]?.[0]).toMatchObject({
        publicPath: '/about-us',
        pageId: published.pageId,
      });
      // The error sits below the block's own call, so containment never ran.
      expect(onBlockRenderError).not.toHaveBeenCalled();

      // Nothing was cached: the next request fails and reports again.
      const second = await visit(handler, '/about-us');
      expect(second.status).toBe(500);
      expect(onRenderError).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.close();
    }
  });
});
