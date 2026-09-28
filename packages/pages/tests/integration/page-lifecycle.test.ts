/**
 * Publish-time address materialisation and the unpublish/schedule/
 * unschedule status transitions (04-13 Task 1, D-20, D-21, D-22), proven
 * against real Postgres: every `<behavior>` bullet, the version-before-
 * status discrimination check, and the publish-time collision refusal.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  PageScheduleNotInFutureError,
  PageStatusError,
  schedulePage,
  unpublishPage,
  unschedulePage,
} from '../../src/lifecycle.js';
import { PageUrlCollisionError } from '../../src/page-routing.js';
import { createPage, getPage, StalePageVersionError } from '../../src/pages.js';
import { publishPage, readPublishedSnapshot } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles, viewer: ['pages:read'] });

describe('page lifecycle: publish-time addresses, unpublish, schedule, unschedule (D-20, D-21, D-22)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let viewer: AuditActor;
  let clockTime = new Date('2026-09-26T10:00:00.000Z');
  const clock = (): Date => clockTime;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });

    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: defineBlocks([
        {
          key: 'section',
          kind: 'section',
          editor: { label: 'Section' },
          schemaVersion: 1,
          properties: {},
        },
      ]),
    });

    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'lifecycle-owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    const viewerUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'lifecycle-viewer@example.com',
      name: 'Viewer',
      roleKey: 'viewer',
    });
    viewer = { userId: viewerUser.userId, roleKey: viewerUser.roleKey };

    deps = { db, recorder, resolver, config, now: clock };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  it('publishes a page with a real, collision-checked address, then unpublishes it -- keeping the publication row, clearing the address, and leaving the first-published marker untouched', async () => {
    clockTime = new Date('2026-09-26T10:00:00.000Z');
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'About us',
      slug: 'about-us',
    });
    const published = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });

    const pageAfterPublish = await getPage(db, page.id);
    expect(pageAfterPublish?.resolvedPath).toBe('en/about-us');
    expect(pageAfterPublish?.status).toBe('published');
    expect(pageAfterPublish?.livePublicationId).toBe(published.id);
    const firstPublishedAt = pageAfterPublish?.firstPublishedAt ?? null;
    expect(firstPublishedAt).not.toBeNull();

    clockTime = new Date('2026-09-26T10:05:00.000Z');
    const auditBefore = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log WHERE action = 'page.unpublish'
    `;
    const unpublished = await unpublishPage(deps, actor, {
      pageId: page.id,
      baseVersion: pageAfterPublish!.version,
    });

    expect(unpublished.status).toBe('draft');
    expect(unpublished.resolvedPath).toBeNull();
    expect(unpublished.publishedAt).toBeNull();
    expect(unpublished.livePublicationId).toBeNull();
    expect(unpublished.firstPublishedAt?.toISOString()).toBe(
      firstPublishedAt!.toISOString(),
    );
    expect(unpublished.version).toBe(pageAfterPublish!.version + 1);

    const historyRows = await handle.sql<{ reason: string; oldPath: string }[]>`
      SELECT reason, old_path AS "oldPath" FROM page_url_history
      WHERE page_id = ${page.id}
    `;
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.reason).toBe('unpublished');
    expect(historyRows[0]?.oldPath).toBe('en/about-us');

    // The publication row survives -- history/preview reads keep serving it
    // -- but readPublishedSnapshot (the live pointer) now reports null.
    const readBack = await readPublishedSnapshot(db, { pageId: page.id });
    expect(readBack).toBeNull();
    const publicationRows = await handle.sql<{ id: string }[]>`
      SELECT id FROM page_publications WHERE id = ${published.id}
    `;
    expect(publicationRows).toHaveLength(1);

    const auditAfter = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log WHERE action = 'page.unpublish'
    `;
    expect(Number(auditAfter[0]!.count)).toBe(
      Number(auditBefore[0]!.count) + 1,
    );
  });

  it('refuses PageUrlCollisionError before any write when the prospective address is already held by another published page in the same locale, leaving the other page untouched', async () => {
    // Two real pages can never structurally collide on address under a
    // fixed pattern (path uniqueness is per-locale, and a fixed pattern is
    // injective in path) -- the "holder" here is manufactured with a
    // direct write so the race this check exists for (T-04-43) is provable
    // without needing two genuinely concurrent transactions.
    const holder = await createPage(deps, actor, {
      locale: 'en',
      title: 'Holder',
      slug: 'holder',
    });
    await handle.sql`
      UPDATE pages
      SET status = 'published', resolved_path = 'en/shared',
        published_at = ${clockTime.toISOString()}::timestamptz,
        first_published_at = ${clockTime.toISOString()}::timestamptz
      WHERE id = ${holder.id}
    `;

    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Shared',
      slug: 'shared',
    });
    const collisionError: unknown = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(collisionError).toBeInstanceOf(PageUrlCollisionError);

    const publicationCount = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM page_publications WHERE page_id = ${page.id}
    `;
    expect(Number(publicationCount[0]!.count)).toBe(0);

    const pageAfter = await getPage(db, page.id);
    expect(pageAfter?.status).toBe('draft');
    expect(pageAfter?.resolvedPath).toBeNull();

    const holderAfter = await getPage(db, holder.id);
    expect(holderAfter?.resolvedPath).toBe('en/shared');
    expect(holderAfter?.status).toBe('published');
  });

  it('refuses PageStatusError when unpublishing a page that is not published', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Never published',
    });
    const error: unknown = await unpublishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageStatusError);
    expect((error as PageStatusError).currentStatus).toBe('draft');
    expect((error as PageStatusError).requiredStatuses).toEqual(['published']);
  });

  it('checks the base version BEFORE the status, so a stale version on a draft page reports StalePageVersionError, never PageStatusError', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Stale version target',
    });
    // The page is a fresh draft: unpublishing it would fail on status
    // ('draft' is not 'published') if version were checked second. A stale
    // baseVersion must surface as StalePageVersionError first.
    const error: unknown = await unpublishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version + 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StalePageVersionError);
  });

  it('schedules a draft page for a future instant, then unschedules it back to draft without publishing', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Scheduled feature',
    });
    const futureInstant = new Date(clockTime.getTime() + 60_000);
    const scheduled = await schedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
      scheduledAt: futureInstant,
    });
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt?.toISOString()).toBe(
      futureInstant.toISOString(),
    );
    expect(scheduled.version).toBe(page.version + 1);

    const unscheduled = await unschedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: scheduled.version,
    });
    expect(unscheduled.status).toBe('draft');
    expect(unscheduled.scheduledAt).toBeNull();
    expect(unscheduled.resolvedPath).toBeNull();
    expect(unscheduled.livePublicationId).toBeNull();
  });

  it('refuses PageScheduleNotInFutureError for a schedule at or before the current instant, writing nothing', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Cannot schedule for now',
    });
    const notInFutureError: unknown = await schedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
      scheduledAt: clockTime,
    }).catch((caught: unknown) => caught);
    expect(notInFutureError).toBeInstanceOf(PageScheduleNotInFutureError);

    const pastError: unknown = await schedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
      scheduledAt: new Date(clockTime.getTime() - 60_000),
    }).catch((caught: unknown) => caught);
    expect(pastError).toBeInstanceOf(PageScheduleNotInFutureError);

    const pageAfter = await getPage(db, page.id);
    expect(pageAfter?.status).toBe('draft');
    expect(pageAfter?.version).toBe(page.version);
  });

  it('refuses PageStatusError when scheduling an already-published page -- a live page has already gone live', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Already live',
      slug: 'already-live',
    });
    const published = await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });
    const pageAfterPublish = await getPage(db, page.id);

    const error: unknown = await schedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: pageAfterPublish!.version,
      scheduledAt: new Date(clockTime.getTime() + 60_000),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageStatusError);
    expect((error as PageStatusError).currentStatus).toBe('published');

    const pageAfterAttempt = await getPage(db, page.id);
    expect(pageAfterAttempt?.status).toBe('published');
    expect(pageAfterAttempt?.livePublicationId).toBe(published.id);
  });

  it('refuses PageStatusError when unscheduling a page that has nothing scheduled', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Nothing scheduled',
    });
    const error: unknown = await unschedulePage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageStatusError);
    expect((error as PageStatusError).currentStatus).toBe('draft');
  });

  it('refuses PermissionDeniedError with a denied audit row for an actor without pages:publish, changing nothing', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Permission denied target',
      slug: 'permission-denied-target',
    });
    await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });
    const pageAfterPublish = await getPage(db, page.id);

    const deniedBefore = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.unpublish' AND outcome = 'denied'
    `;
    const error: unknown = await unpublishPage(deps, viewer, {
      pageId: page.id,
      baseVersion: pageAfterPublish!.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const deniedAfter = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.unpublish' AND outcome = 'denied'
    `;
    expect(Number(deniedAfter[0]!.count)).toBe(
      Number(deniedBefore[0]!.count) + 1,
    );

    const pageAfterDenied = await getPage(db, page.id);
    expect(pageAfterDenied?.status).toBe('published');
    expect(pageAfterDenied?.version).toBe(pageAfterPublish!.version);
  });
});
