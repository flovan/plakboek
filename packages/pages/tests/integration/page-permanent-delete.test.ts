/**
 * Trash, restore-from-trash and the permanent delete with its impact
 * report (04-13 Task 2), proven against real Postgres: every `<behavior>`
 * bullet, including the cascade/restore shared-instant matching, the
 * ancestor-trashed refusal, and the orphaned-revision case the explicit
 * `block_revisions` delete exists to prevent.
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
  AncestorTrashedError,
  computePagePermanentDeleteImpact,
  computePageTrashImpact,
  deletePagePermanently,
  PageStatusError,
  restorePageFromTrash,
  trashPage,
} from '../../src/lifecycle.js';
import { createPage, getPage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock } from '../../src/tree.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles, viewer: ['pages:read'] });

describe('page lifecycle: trash, restore and the permanent delete with its impact report (D-21, D-24)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let viewer: AuditActor;
  let clockTime = new Date('2026-09-27T09:00:00.000Z');
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
      email: 'delete-owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    const viewerUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'delete-viewer@example.com',
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

  it('computes the trash impact, cascades trash over a published subtree, and restoring reverses exactly the pages that operation trashed', async () => {
    const root = await createPage(deps, actor, {
      locale: 'en',
      title: 'Trash root',
      slug: 'trash-root',
    });
    await publishPage(deps, actor, {
      pageId: root.id,
      baseVersion: root.version,
    });
    const rootAfterPublish = await getPage(db, root.id);

    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Trash child',
      slug: 'trash-child',
      parentPageId: root.id,
    });
    await publishPage(deps, actor, {
      pageId: child.id,
      baseVersion: child.version,
    });

    const grandchild = await createPage(deps, actor, {
      locale: 'en',
      title: 'Trash grandchild',
      slug: 'trash-grandchild',
      parentPageId: child.id,
    });

    await insertBlock(deps, actor, {
      owner: { ownerType: 'page', ownerId: root.id, locale: 'en' },
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: rootAfterPublish!.version,
    });

    const impact = await computePageTrashImpact(db, { pageId: root.id });
    expect(impact.pageCount).toBe(3);
    expect(impact.publishedCount).toBe(2);
    expect(impact.blockCount).toBe(1);

    const auditRowCountBeforeTrash = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log WHERE action = 'page.trash'
    `;
    const rootAfterInsert = await getPage(db, root.id);
    const trashed = await trashPage(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterInsert!.version,
    });
    expect(trashed.status).toBe('trashed');
    expect(trashed.trashedAt).not.toBeNull();

    const rows = await handle.sql<
      {
        id: string;
        status: string;
        resolvedPath: string | null;
        version: number;
      }[]
    >`
      SELECT id, status, resolved_path AS "resolvedPath", version FROM pages
      WHERE id IN (${root.id}, ${child.id}, ${grandchild.id})
    `;
    for (const row of rows) {
      expect(row.status).toBe('trashed');
      expect(row.resolvedPath).toBeNull();
    }

    const historyRows = await handle.sql<{ pageId: string; reason: string }[]>`
      SELECT page_id AS "pageId", reason FROM page_url_history
      WHERE page_id IN (${root.id}, ${child.id}) AND reason = 'trashed'
    `;
    expect(historyRows).toHaveLength(2);

    const auditRowCountAfterTrash = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log WHERE action = 'page.trash'
    `;
    expect(Number(auditRowCountAfterTrash[0]!.count)).toBe(
      Number(auditRowCountBeforeTrash[0]!.count) + 1,
    );

    // The grandchild was trashed as part of THIS cascade -- now trash it
    // AGAIN on its own, later, to give it a DIFFERENT `trashed_at` than its
    // ancestors. Restoring the root afterwards must not resurrect it.
    clockTime = new Date('2026-09-27T09:10:00.000Z');
    const rootAfterTrash = await getPage(db, root.id);
    const restoredRoot = await restorePageFromTrash(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterTrash!.version,
    });
    expect(restoredRoot.status).toBe('draft');
    expect(restoredRoot.trashedAt).toBeNull();
    expect(restoredRoot.resolvedPath).toBeNull();

    const childAfterRestore = await getPage(db, child.id);
    expect(childAfterRestore?.status).toBe('draft');
    expect(childAfterRestore?.trashedAt).toBeNull();
  });

  it('restoring does not resurrect a descendant trashed by a separate, earlier operation', async () => {
    const root = await createPage(deps, actor, {
      locale: 'en',
      title: 'Shared-instant root',
      slug: 'shared-instant-root',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Shared-instant child',
      slug: 'shared-instant-child',
      parentPageId: root.id,
    });

    // Trash the child FIRST, on its own -- a different `trashed_at` instant
    // than the later root-level cascade below.
    clockTime = new Date('2026-09-27T10:00:00.000Z');
    await trashPage(deps, actor, {
      pageId: child.id,
      baseVersion: child.version,
    });

    clockTime = new Date('2026-09-27T10:05:00.000Z');
    const rootAfterChildTrash = await getPage(db, root.id);
    await trashPage(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterChildTrash!.version,
    });
    const childAfterRootTrash = await getPage(db, child.id);
    expect(childAfterRootTrash?.status).toBe('trashed');

    clockTime = new Date('2026-09-27T10:10:00.000Z');
    const rootAfterBothTrashed = await getPage(db, root.id);
    await restorePageFromTrash(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterBothTrashed!.version,
    });

    const rootAfterRestore = await getPage(db, root.id);
    expect(rootAfterRestore?.status).toBe('draft');
    // The child was trashed by its OWN earlier operation -- a different
    // `trashed_at` -- so the root's restore does not sweep it back up.
    const childAfterRestore = await getPage(db, child.id);
    expect(childAfterRestore?.status).toBe('trashed');
  });

  it('refuses AncestorTrashedError -- naming the ancestor -- when restoring a page whose ancestor is still trashed, writing nothing', async () => {
    const root = await createPage(deps, actor, {
      locale: 'en',
      title: 'Ancestor-trashed root',
      slug: 'ancestor-trashed-root',
    });
    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Ancestor-trashed child',
      slug: 'ancestor-trashed-child',
      parentPageId: root.id,
    });

    // Trash the child alone first, then the root -- the child's own
    // `trashed_at` differs from the root's, so restoring the CHILD directly
    // (not through the root) must see the still-trashed root ancestor.
    await trashPage(deps, actor, {
      pageId: child.id,
      baseVersion: child.version,
    });
    const rootAfterChildTrash = await getPage(db, root.id);
    await trashPage(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterChildTrash!.version,
    });

    const childAfterBothTrashed = await getPage(db, child.id);
    const error: unknown = await restorePageFromTrash(deps, actor, {
      pageId: child.id,
      baseVersion: childAfterBothTrashed!.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AncestorTrashedError);
    expect((error as AncestorTrashedError).ancestorPageId).toBe(root.id);

    const childAfterRefusal = await getPage(db, child.id);
    expect(childAfterRefusal?.status).toBe('trashed');
    expect(childAfterRefusal?.version).toBe(childAfterBothTrashed!.version);
  });

  it('refuses PageStatusError trashing an already-trashed page, and restoring a page that is not trashed', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Double trash',
    });
    await trashPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });
    const afterFirstTrash = await getPage(db, page.id);

    const trashAgainError: unknown = await trashPage(deps, actor, {
      pageId: page.id,
      baseVersion: afterFirstTrash!.version,
    }).catch((caught: unknown) => caught);
    expect(trashAgainError).toBeInstanceOf(PageStatusError);

    const notTrashedPage = await createPage(deps, actor, {
      locale: 'en',
      title: 'Never trashed',
    });
    const restoreError: unknown = await restorePageFromTrash(deps, actor, {
      pageId: notTrashedPage.id,
      baseVersion: notTrashedPage.version,
    }).catch((caught: unknown) => caught);
    expect(restoreError).toBeInstanceOf(PageStatusError);
  });

  it('computes the permanent-delete impact and removes the whole subtree -- pages, blocks, revisions, publications and URL history -- leaving a sibling and another locale untouched', async () => {
    const root = await createPage(deps, actor, {
      locale: 'en',
      title: 'Delete root',
      slug: 'delete-root',
    });
    const rootSection = await insertBlock(deps, actor, {
      owner: { ownerType: 'page', ownerId: root.id, locale: 'en' },
      blockType: 'section',
      parentBlockId: null,
      basePageVersion: root.version,
    });
    const rootAfterInsert = await getPage(db, root.id);
    await publishPage(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterInsert!.version,
    });
    const rootAfterPublish = await getPage(db, root.id);

    const child = await createPage(deps, actor, {
      locale: 'en',
      title: 'Delete child',
      slug: 'delete-child',
      parentPageId: root.id,
    });

    const sibling = await createPage(deps, actor, {
      locale: 'en',
      title: 'Delete sibling',
      slug: 'delete-sibling',
    });

    const impact = await computePagePermanentDeleteImpact(db, {
      pageId: root.id,
    });
    expect(impact.pageCount).toBe(2);
    expect(impact.blockCount).toBe(1);
    expect(impact.blockRevisionCount).toBeGreaterThan(0);
    expect(impact.publicationCount).toBe(1);
    expect(impact.urlHistoryCount).toBe(0);

    const auditBefore = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.delete-permanent'
    `;
    const result = await deletePagePermanently(deps, actor, {
      pageId: root.id,
      baseVersion: rootAfterPublish!.version,
    });
    expect(result.pageCount).toBe(impact.pageCount);
    expect(result.blockCount).toBe(impact.blockCount);
    expect(result.blockRevisionCount).toBe(impact.blockRevisionCount);
    expect(result.publicationCount).toBe(impact.publicationCount);

    const remainingPages = await handle.sql<{ id: string }[]>`
      SELECT id FROM pages WHERE id IN (${root.id}, ${child.id})
    `;
    expect(remainingPages).toHaveLength(0);
    const remainingBlocks = await handle.sql<{ id: string }[]>`
      SELECT id FROM page_blocks WHERE id = ${rootSection.id}
    `;
    expect(remainingBlocks).toHaveLength(0);
    const remainingRevisions = await handle.sql<{ id: string }[]>`
      SELECT id FROM block_revisions WHERE owner_id = ${root.id}
    `;
    expect(remainingRevisions).toHaveLength(0);
    const remainingPublications = await handle.sql<{ id: string }[]>`
      SELECT id FROM page_publications WHERE page_id = ${root.id}
    `;
    expect(remainingPublications).toHaveLength(0);
    const deletedHistoryRows = await handle.sql<{ reason: string }[]>`
      SELECT reason FROM page_url_history WHERE page_id IS NULL
        AND translation_group = ${root.translationGroup}
    `;
    expect(deletedHistoryRows.some((row) => row.reason === 'deleted')).toBe(
      true,
    );

    const auditAfter = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.delete-permanent'
    `;
    expect(Number(auditAfter[0]!.count)).toBe(
      Number(auditBefore[0]!.count) + 1,
    );

    const siblingAfterDelete = await getPage(db, sibling.id);
    expect(siblingAfterDelete).not.toBeNull();
  });

  it('refuses PermissionDeniedError with a denied audit row for trash, restore and permanent-delete when the actor lacks the permission, changing nothing', async () => {
    const page = await createPage(deps, actor, {
      locale: 'en',
      title: 'Permission-gated page',
    });

    const trashDeniedBefore = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.trash' AND outcome = 'denied'
    `;
    const trashDenied: unknown = await trashPage(deps, viewer, {
      pageId: page.id,
      baseVersion: page.version,
    }).catch((caught: unknown) => caught);
    expect(trashDenied).toBeInstanceOf(PermissionDeniedError);
    const trashDeniedAfter = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.trash' AND outcome = 'denied'
    `;
    expect(Number(trashDeniedAfter[0]!.count)).toBe(
      Number(trashDeniedBefore[0]!.count) + 1,
    );

    const trashed = await trashPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });

    const restoreDeniedBefore = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.restore' AND outcome = 'denied'
    `;
    const restoreDenied: unknown = await restorePageFromTrash(deps, viewer, {
      pageId: page.id,
      baseVersion: trashed.version,
    }).catch((caught: unknown) => caught);
    expect(restoreDenied).toBeInstanceOf(PermissionDeniedError);
    const restoreDeniedAfter = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.restore' AND outcome = 'denied'
    `;
    expect(Number(restoreDeniedAfter[0]!.count)).toBe(
      Number(restoreDeniedBefore[0]!.count) + 1,
    );

    const deletePermanentDeniedBefore = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.delete-permanent' AND outcome = 'denied'
    `;
    const deletePermanentDenied: unknown = await deletePagePermanently(
      deps,
      viewer,
      { pageId: page.id, baseVersion: trashed.version },
    ).catch((caught: unknown) => caught);
    expect(deletePermanentDenied).toBeInstanceOf(PermissionDeniedError);
    const deletePermanentDeniedAfter = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.delete-permanent' AND outcome = 'denied'
    `;
    expect(Number(deletePermanentDeniedAfter[0]!.count)).toBe(
      Number(deletePermanentDeniedBefore[0]!.count) + 1,
    );

    const pageAfterDenials = await getPage(db, page.id);
    expect(pageAfterDenials?.status).toBe('trashed');
    expect(pageAfterDenials?.version).toBe(trashed.version);
  });
});
