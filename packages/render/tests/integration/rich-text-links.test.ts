/**
 * Page links on a visitor page, against real Postgres (D-18): a link to a
 * live page renders that page's public path, a link to a page that is not
 * live renders unlinked text, and a page that holds no page links issues no
 * extra statement.
 */
import { createMemoryCache } from '@plakboek/cache';
import {
  createPage,
  getPage,
  publishPage,
  unpublishPage,
} from '@plakboek/pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisitorHandler } from '../../src/server.js';
import { createCountingDb, type CountingDb } from './counting-db.js';
import {
  createFixture,
  fixtureConfig,
  linkingDoc,
  pagesDepsFor,
  publishHeadingPage,
  publishPageWithBlock,
  visit,
  type Fixture,
} from './fixtures.js';

let fixture: Fixture;
let counting: CountingDb;

beforeAll(async () => {
  fixture = await createFixture();
  counting = createCountingDb(fixture.testDatabase.connectionString);
});

afterAll(async () => {
  await counting.close();
  await fixture.close();
});

describe('visitor page links', () => {
  it('links to a live page by its public path and leaves a page that is not live unlinked', async () => {
    const deps = pagesDepsFor(fixture);
    const target = await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Target page',
      text: 'Target',
    });
    const draft = await createPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Draft page',
    });
    await publishPageWithBlock(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Linking page',
      blockType: 'prose',
      props: {
        body: linkingDoc([
          { text: 'Live link', pageId: target.pageId },
          { text: 'Hidden link', pageId: draft.id },
        ]),
      },
    });
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
    });

    const response = await visit(handler, '/linking-page');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<a [^>]*href="\/target-page"[^>]*>Live link<\/a>/);
    expect(html).toContain('Hidden link');
    expect(html).not.toMatch(/<a [^>]*>Hidden link<\/a>/);
    expect(html).not.toContain('draft-page');
  });

  it('renders the link field of a button through the same resolution', async () => {
    const deps = pagesDepsFor(fixture);
    const target = await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Button target',
      text: 'Target',
    });
    await publishPageWithBlock(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Button page',
      blockType: 'button',
      props: {
        label: 'Read more',
        variant: 'primary',
        link: { href: null, pageId: target.pageId, target: null },
      },
    });
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
    });
    const html = await (await visit(handler, '/button-page')).text();
    expect(html).toMatch(/<a [^>]*href="\/button-target"[^>]*>Read more<\/a>/);
  });

  it('costs no extra statement when no block holds a page link', async () => {
    const deps = pagesDepsFor(fixture);
    const target = await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Counted target',
      text: 'Target',
    });
    await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Plain heading',
      text: 'No links',
    });
    await publishPageWithBlock(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Plain prose',
      blockType: 'prose',
      props: { body: linkingDoc([]) },
    });
    await publishPageWithBlock(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Counted link',
      blockType: 'prose',
      props: {
        body: linkingDoc([{ text: 'Go', pageId: target.pageId }]),
      },
    });
    const handler = createVisitorHandler({
      db: counting.db,
      config: fixtureConfig,
    });

    counting.reset();
    await (await visit(handler, '/plain-heading')).text();
    const baseline = counting.statements.length;
    expect(baseline).toBeGreaterThan(0);

    counting.reset();
    await (await visit(handler, '/plain-prose')).text();
    expect(counting.statements).toHaveLength(baseline);

    // One batch for the url pattern and one for the pages, never one per link.
    counting.reset();
    const html = await (await visit(handler, '/counted-link')).text();
    expect(html).toContain('href="/counted-target"');
    expect(counting.statements).toHaveLength(baseline + 2);
  });
});

describe('a cached page that links to another page', () => {
  it('is refreshed when the linked page is unpublished and published again', async () => {
    const lru = createMemoryCache();
    const deps = pagesDepsFor(fixture, lru);
    const target = await publishHeadingPage(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Cached target',
      text: 'Target',
    });
    await publishPageWithBlock(deps, fixture.superadmin, {
      locale: 'en',
      title: 'Cached linker',
      blockType: 'prose',
      props: {
        body: linkingDoc([{ text: 'Cached link', pageId: target.pageId }]),
      },
    });
    const handler = createVisitorHandler({
      db: fixture.handle.db,
      config: fixtureConfig,
      cache: lru,
    });
    const linked = /<a [^>]*href="\/cached-target"[^>]*>Cached link<\/a>/;

    expect(await (await visit(handler, '/cached-linker')).text()).toMatch(
      linked,
    );

    const live = await getPage(fixture.handle.db, target.pageId);
    await unpublishPage(deps, fixture.superadmin, {
      pageId: target.pageId,
      baseVersion: live?.version ?? -1,
    });
    const afterUnpublish = await (
      await visit(handler, '/cached-linker')
    ).text();
    expect(afterUnpublish).toContain('Cached link');
    expect(afterUnpublish).not.toMatch(linked);

    const draft = await getPage(fixture.handle.db, target.pageId);
    await publishPage(deps, fixture.superadmin, {
      pageId: target.pageId,
      baseVersion: draft?.version ?? -1,
    });
    expect(await (await visit(handler, '/cached-linker')).text()).toMatch(
      linked,
    );
  });
});
