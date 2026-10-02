/**
 * A publish purges every composed cache layer, strictly after its
 * transaction commits; a refused or denied publish purges nothing; and a
 * failing layer neither fails the committed publish nor stops the other
 * layers from being purged.
 */
import { PermissionDeniedError } from '@plakboek/auth';
import {
  composeInvalidators,
  createMemoryCache,
  pageTag,
  type CacheInvalidator,
} from '@plakboek/cache';
import { createDb } from '@plakboek/db';
import {
  DegradedBlockPublishError,
  getPage,
  publishPage,
  StalePageVersionError,
  updateBlockProps,
} from '@plakboek/pages';
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

type SpyLayer = CacheInvalidator & {
  readonly calls: (readonly string[])[];
  /** The live publication id a second connection saw during each call. */
  readonly observed: (string | null)[];
};

/** A layer that records each purge and what a separate connection sees of
 * the page's live pointer at that moment. */
function spyLayer(
  connectionString: string,
  pageIdOf: () => string,
  behaviour?: () => Promise<void>,
): SpyLayer {
  const calls: (readonly string[])[] = [];
  const observed: (string | null)[] = [];
  return {
    calls,
    observed,
    async purge(tags) {
      calls.push(tags);
      const separate = createDb({ connectionString });
      try {
        const [row] = await separate.sql<{ id: string | null }[]>`
          SELECT live_publication_id AS id FROM pages WHERE id = ${pageIdOf()}
        `;
        observed.push(row?.id ?? null);
      } finally {
        await separate.close();
      }
      if (behaviour !== undefined) await behaviour();
    },
  };
}

async function bodyOf(response: Response): Promise<string> {
  return await response.text();
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options?: Parameters<typeof createFixture>[0],
): Promise<void> {
  resetRenderCounts();
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

describe('publish purges every cache layer after commit', () => {
  it('purges each composed layer once, and the layer already sees the committed pointer', async () => {
    await withFixture(async (fixture) => {
      const lru = createMemoryCache();
      let pageId = '';
      const spy = spyLayer(fixture.testDatabase.connectionString, () => pageId);
      const deps = pagesDepsFor(fixture, composeInvalidators(lru, spy));
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        cache: lru,
      });
      const published = await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Hello v1',
      });
      pageId = published.pageId;
      spy.calls.length = 0;
      spy.observed.length = 0;

      expect(await bodyOf(await visit(handler, '/about-us'))).toContain(
        'Hello v1',
      );
      await updateBlockProps(deps, fixture.superadmin, {
        blockId: published.headingId,
        baseVersion: published.headingVersion,
        props: { text: 'Hello v2' },
      });
      const publication = await publishPage(deps, fixture.superadmin, {
        pageId,
        baseVersion: published.pageVersion,
      });

      expect(spy.calls).toEqual([[pageTag(pageId)]]);
      expect(spy.observed).toEqual([publication.id]);
      expect(await bodyOf(await visit(handler, '/about-us'))).toContain(
        'Hello v2',
      );
    });
  });

  it('purges nothing for a stale, degraded or denied publish, and the cached version keeps serving', async () => {
    await withFixture(async (fixture) => {
      const lru = createMemoryCache();
      let pageId = '';
      const spy = spyLayer(fixture.testDatabase.connectionString, () => pageId);
      const deps = pagesDepsFor(fixture, composeInvalidators(lru, spy));
      const handler = createVisitorHandler({
        db: fixture.handle.db,
        config: fixtureConfig,
        cache: lru,
      });
      const published = await publishHeadingPage(deps, fixture.superadmin, {
        locale: 'en',
        title: 'About us',
        text: 'Hello v1',
      });
      pageId = published.pageId;
      spy.calls.length = 0;
      spy.observed.length = 0;

      const cached = await bodyOf(await visit(handler, '/about-us'));
      expect(cached).toContain('Hello v1');
      const rendersBefore = renderCounts.heading;

      const stale: unknown = await publishPage(deps, fixture.superadmin, {
        pageId,
        baseVersion: published.pageVersion - 1,
      }).catch((caught: unknown) => caught);
      expect(stale).toBeInstanceOf(StalePageVersionError);

      const denied: unknown = await publishPage(deps, fixture.viewer, {
        pageId,
        baseVersion: published.pageVersion,
      }).catch((caught: unknown) => caught);
      expect(denied).toBeInstanceOf(PermissionDeniedError);

      // A stored prop that no longer validates degrades the block, so the
      // publish is refused.
      await fixture.handle.sql`
        UPDATE page_blocks SET props = '{"text": 123}'::jsonb
        WHERE id = ${published.headingId}
      `;
      const current = await getPage(fixture.handle.db, pageId);
      const degraded: unknown = await publishPage(deps, fixture.superadmin, {
        pageId,
        baseVersion: current?.version ?? -1,
      }).catch((caught: unknown) => caught);
      expect(degraded).toBeInstanceOf(DegradedBlockPublishError);

      expect(spy.calls).toEqual([]);
      expect(await bodyOf(await visit(handler, '/about-us'))).toBe(cached);
      expect(renderCounts.heading).toBe(rendersBefore);
    });
  });

  it('never fails a committed publish when a layer fails, still purges the other layers, and reports the failure once', async () => {
    const failures: unknown[] = [];
    await withFixture(
      async (fixture) => {
        const lru = createMemoryCache();
        const broken: CacheInvalidator = {
          async purge() {
            throw new Error('proxy unreachable');
          },
        };
        const deps = pagesDepsFor(fixture, composeInvalidators(broken, lru));
        const handler = createVisitorHandler({
          db: fixture.handle.db,
          config: fixtureConfig,
          cache: lru,
        });
        const published = await publishHeadingPage(deps, fixture.superadmin, {
          locale: 'en',
          title: 'About us',
          text: 'Hello v1',
        });
        failures.length = 0;

        expect(await bodyOf(await visit(handler, '/about-us'))).toContain(
          'Hello v1',
        );
        await updateBlockProps(deps, fixture.superadmin, {
          blockId: published.headingId,
          baseVersion: published.headingVersion,
          props: { text: 'Hello v2' },
        });
        const publication = await publishPage(deps, fixture.superadmin, {
          pageId: published.pageId,
          baseVersion: published.pageVersion,
        });

        expect(publication.isDraft).toBe(false);
        expect(await bodyOf(await visit(handler, '/about-us'))).toContain(
          'Hello v2',
        );
        expect(failures).toHaveLength(1);
      },
      {
        onAfterCommitFailed: (failure) => {
          failures.push(failure);
        },
      },
    );
  });
});
