/**
 * Restore preview classification (`computeBlockRestorePreview`) and audited
 * batch restore (`restoreRevisionBatch`), proven against real Postgres
 * (D-13, mirrors `@plakboek/content`'s D-17 restore shape; T-04-04, T-04-35,
 * T-04-36, T-04-37).
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
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
import { describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage, getPage, StalePageVersionError } from '../../src/pages.js';
import {
  BlockDepthExceededError,
  BlockPlacementError,
  SectionNestingDepthExceededError,
} from '../../src/placement.js';
import { defineBlocks } from '../../src/registry.js';
import {
  computeBlockRestorePreview,
  DegradedRestoreError,
  listBatchRevisions,
  restoreRevisionBatch,
} from '../../src/revisions.js';
import {
  deleteBlock,
  insertBlock,
  moveBlock,
  updateBlockProps,
} from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
});

type StoredRevisionSnapshot = {
  readonly id: string;
  readonly propsText: string | null;
  readonly schemaVersion: number;
};

async function snapshotAllRevisions(
  handle: Db,
): Promise<readonly StoredRevisionSnapshot[]> {
  const rows = await handle.sql<
    { id: string; propsText: string | null; schemaVersion: number }[]
  >`
    SELECT id, props::text AS "propsText", schema_version AS "schemaVersion"
    FROM block_revisions
  `;
  return rows;
}

describe('restore preview classification and audited batch restore (D-13)', () => {
  it('classifies mapped/defaulted/dropped/failed and unregistered types, and restoreRevisionBatch re-creates, re-parents and rewrites through one audited, version-checked, placement-validated, immutable-history mutation', async () => {
    const testDatabase = await createTestDatabase();
    let handle: Db | undefined;
    try {
      await runMigrations({
        connectionString: testDatabase.connectionString,
      });
      handle = createDb({ connectionString: testDatabase.connectionString });

      const resolver: PermissionResolver = createPermissionResolver(roles);
      const recorder: AuditRecorder = createAuditRecorder({
        db: handle.db,
        resolver,
      });
      let tick = 0;
      const clock = (): Date =>
        new Date(Date.parse('2026-09-25T10:00:00.000Z') + tick++ * 1000);

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: 'superadmin',
      });
      const superadmin: AuditActor = {
        userId: superadminUser.userId,
        roleKey: superadminUser.roleKey,
      };
      const viewerUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'viewer@example.com',
        name: 'Viewer',
        roleKey: 'viewer',
      });
      const viewer: AuditActor = {
        userId: viewerUser.userId,
        roleKey: viewerUser.roleKey,
      };

      const content = defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      });

      // -- v1: the registered shape every fixture below is created under --
      const cardV1 = {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 1,
        properties: {
          tag: { fieldType: 'short_text', label: 'Tag', required: true },
          legacy: { fieldType: 'short_text', label: 'Legacy', required: false },
        },
      } as const;
      const noteV1 = {
        key: 'note',
        kind: 'block',
        editor: { label: 'Note' },
        schemaVersion: 1,
        properties: {
          body: { fieldType: 'short_text', label: 'Body', required: true },
        },
      } as const;
      const configV1 = definePagesConfig({
        content,
        blocks: defineBlocks([cardV1, noteV1]),
      });
      const depsV1: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config: configV1,
        now: clock,
      };

      const page = await createPage(depsV1, superadmin, {
        locale: 'en',
        title: 'Restore fixture',
      });
      const root = await insertBlock(depsV1, superadmin, {
        owner: { ownerType: 'page', ownerId: page.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'v1', legacy: 'old' },
        basePageVersion: page.version,
      });
      let pageVersion = page.version + 1;

      // -- Snapshot every existing revision row's props/schema_version -----
      // BEFORE any restore -- the immutability check re-reads this set at
      // the very end.
      const preRestoreSnapshot = await snapshotAllRevisions(handle);

      // -- Bullet 1: unchanged declarations -> every property mapped, -----
      // read-only.
      const rootBatchId = (
        await handle.sql<{ revisionBatchId: string }[]>`
          SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
          WHERE block_id = ${root.id} AND change_type = 'create'
        `
      )[0]!.revisionBatchId;
      const auditCountBeforePreview = (
        await handle.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM audit_log
        `
      )[0]!.count;
      const unchangedPreview = await computeBlockRestorePreview(handle.db, {
        revisionBatchId: rootBatchId,
      });
      expect(unchangedPreview.blocks).toHaveLength(1);
      expect(
        unchangedPreview.blocks[0]!.properties.every(
          (property) => property.status === 'mapped',
        ),
      ).toBe(true);
      expect(unchangedPreview.failedCount).toBe(0);
      const auditCountAfterPreview = (
        await handle.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM audit_log
        `
      )[0]!.count;
      expect(auditCountAfterPreview).toBe(auditCountBeforePreview);

      // -- Fixtures for the three restorable change kinds, all under v1 ---
      const note = await insertBlock(depsV1, superadmin, {
        owner: { ownerType: 'page', ownerId: page.id, locale: 'en' },
        blockType: 'note',
        parentBlockId: root.id,
        props: { body: 'hello' },
        basePageVersion: pageVersion,
      });
      pageVersion += 1;

      const edited1 = await updateBlockProps(depsV1, superadmin, {
        blockId: note.id,
        baseVersion: note.version,
        props: { body: 'world' },
      });
      const editBatchId = (
        await handle.sql<{ revisionBatchId: string }[]>`
          SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
          WHERE block_id = ${note.id} AND change_type = 'update'
          ORDER BY created_at DESC LIMIT 1
        `
      )[0]!.revisionBatchId;
      await updateBlockProps(depsV1, superadmin, {
        blockId: note.id,
        baseVersion: edited1.version,
        props: { body: 'final' },
      });

      // A second root-level section to move `note` into and back out of --
      // `note` (kind: 'block') can never sit directly under the page (D-19),
      // so the move destination must be another section.
      const root2 = await insertBlock(depsV1, superadmin, {
        owner: { ownerType: 'page', ownerId: page.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'root2' },
        basePageVersion: pageVersion,
      });
      pageVersion += 1;

      await moveBlock(depsV1, superadmin, {
        blockId: note.id,
        baseVersion: (
          await handle.sql<{ version: number }[]>`
          SELECT version FROM page_blocks WHERE id = ${note.id}
        `
        )[0]!.version,
        pageId: page.id,
        basePageVersion: pageVersion,
        newParentBlockId: root2.id,
      });
      pageVersion += 1;
      const moveBatchId = (
        await handle.sql<{ revisionBatchId: string }[]>`
          SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
          WHERE block_id = ${note.id} AND change_type = 'move'
        `
      )[0]!.revisionBatchId;

      const throwaway = await insertBlock(depsV1, superadmin, {
        owner: { ownerType: 'page', ownerId: page.id, locale: 'en' },
        blockType: 'note',
        parentBlockId: root.id,
        props: { body: 'gone soon' },
        basePageVersion: pageVersion,
      });
      pageVersion += 1;
      await deleteBlock(depsV1, superadmin, {
        blockId: throwaway.id,
        baseVersion: throwaway.version,
        pageId: page.id,
        basePageVersion: pageVersion,
      });
      pageVersion += 1;
      const deleteBatchId = (
        await handle.sql<{ revisionBatchId: string }[]>`
          SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
          WHERE change_type = 'delete' AND owner_id = ${page.id}
        `
      )[0]!.revisionBatchId;

      // -- restoreRevisionBatch: rewrites props for an edited block --------
      const beforeUpdateRestoreVersion = await getPage(handle.db, page.id);
      const restoredUpdate = await restoreRevisionBatch(depsV1, superadmin, {
        revisionBatchId: editBatchId,
        pageId: page.id,
        basePageVersion: beforeUpdateRestoreVersion!.version,
      });
      expect(restoredUpdate.restoredBlocks).toBe(1);
      const noteAfterRestoreUpdate = await handle.sql<
        { body: string }[]
      >`SELECT props->>'body' AS body FROM page_blocks WHERE id = ${note.id}`;
      expect(noteAfterRestoreUpdate[0]?.body).toBe('world');
      const pageAfterUpdateRestore = await getPage(handle.db, page.id);
      expect(pageAfterUpdateRestore!.version).toBe(
        beforeUpdateRestoreVersion!.version + 1,
      );
      // Bumps the page version exactly once and writes one new batch.
      const newRestoreBatchRevisions = await listBatchRevisions(handle.db, {
        revisionBatchId: restoredUpdate.revisionBatchId,
      });
      expect(newRestoreBatchRevisions).toHaveLength(1);
      expect(newRestoreBatchRevisions[0]?.changeType).toBe('update');

      // -- restoreRevisionBatch: re-parents a moved block -------------------
      const beforeMoveRestore = await getPage(handle.db, page.id);
      await restoreRevisionBatch(depsV1, superadmin, {
        revisionBatchId: moveBatchId,
        pageId: page.id,
        basePageVersion: beforeMoveRestore!.version,
      });
      const noteAfterMoveRestore = await handle.sql<
        { parentBlockId: string | null }[]
      >`SELECT parent_block_id AS "parentBlockId" FROM page_blocks WHERE id = ${note.id}`;
      expect(noteAfterMoveRestore[0]?.parentBlockId).toBe(root.id);

      // -- restoreRevisionBatch: re-creates a deleted block ------------------
      const beforeDeleteRestore = await getPage(handle.db, page.id);
      const restoredDelete = await restoreRevisionBatch(depsV1, superadmin, {
        revisionBatchId: deleteBatchId,
        pageId: page.id,
        basePageVersion: beforeDeleteRestore!.version,
      });
      expect(restoredDelete.restoredBlocks).toBe(1);
      const recreatedRows = await handle.sql<
        {
          id: string;
          body: string;
          parentBlockId: string | null;
          sortOrder: number;
        }[]
      >`
        SELECT id, props->>'body' AS body, parent_block_id AS "parentBlockId",
          sort_order AS "sortOrder"
        FROM page_blocks WHERE block_type = 'note' AND props->>'body' = 'gone soon'
      `;
      expect(recreatedRows).toHaveLength(1);
      expect(recreatedRows[0]?.id).not.toBe(throwaway.id); // fresh id
      expect(recreatedRows[0]?.parentBlockId).toBe(root.id);
      expect(recreatedRows[0]?.sortOrder).toBe(throwaway.sortOrder);

      // -- Stale basePageVersion refuses, writes nothing ---------------------
      const pageBeforeStale = await getPage(handle.db, page.id);
      const staleError: unknown = await restoreRevisionBatch(
        depsV1,
        superadmin,
        {
          revisionBatchId: editBatchId,
          pageId: page.id,
          basePageVersion: pageBeforeStale!.version - 1,
        },
      ).catch((caught: unknown) => caught);
      expect(staleError).toBeInstanceOf(StalePageVersionError);
      const pageAfterStale = await getPage(handle.db, page.id);
      expect(pageAfterStale!.version).toBe(pageBeforeStale!.version);

      // -- Permission denial: no pages:edit -> PermissionDeniedError + -----
      // denied audit row.
      const auditCountBeforeDenied = (
        await handle.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'page.restore-batch' AND outcome = 'denied'
        `
      )[0]!.count;
      const deniedError: unknown = await restoreRevisionBatch(depsV1, viewer, {
        revisionBatchId: editBatchId,
        pageId: page.id,
        basePageVersion: (await getPage(handle.db, page.id))!.version,
      }).catch((caught: unknown) => caught);
      expect(deniedError).toBeInstanceOf(PermissionDeniedError);
      const auditCountAfterDenied = (
        await handle.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'page.restore-batch' AND outcome = 'denied'
        `
      )[0]!.count;
      expect(Number(auditCountAfterDenied)).toBe(
        Number(auditCountBeforeDenied) + 1,
      );

      // ---------------------------------------------------------------
      // Property classification coverage: mapped/defaulted/dropped/failed
      // in one preview, by re-registering `card` with a narrower/wider
      // property set than the original create-batch's stored props.
      // ---------------------------------------------------------------
      const cardV2 = {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 1,
        properties: {
          tag: { fieldType: 'short_text', label: 'Tag', required: true },
          subtitle: {
            fieldType: 'short_text',
            label: 'Subtitle',
            required: true,
            defaultValue: 'Untitled',
          },
          summary: {
            fieldType: 'short_text',
            label: 'Summary',
            required: true,
          },
        },
      } as const;
      const configV2 = definePagesConfig({
        content,
        blocks: defineBlocks([cardV2, noteV1]),
      });
      const depsV2: PagesDeps = { ...depsV1, config: configV2 };

      const classificationPreview = await computeBlockRestorePreview(
        handle.db,
        { revisionBatchId: rootBatchId },
      );
      const rootPreviewV2 = classificationPreview.blocks[0]!;
      const byKey = new Map(
        rootPreviewV2.properties.map((property) => [
          property.propertyKey,
          property,
        ]),
      );
      expect(byKey.get('tag')?.status).toBe('mapped');
      expect(byKey.get('tag')?.value).toBe('v1');
      expect(byKey.get('legacy')?.status).toBe('dropped');
      expect(byKey.get('subtitle')?.status).toBe('defaulted');
      expect(byKey.get('subtitle')?.value).toBe('Untitled');
      expect(byKey.get('summary')?.status).toBe('failed');
      expect(classificationPreview.mappedCount).toBe(1);
      expect(classificationPreview.defaultedCount).toBe(1);
      expect(classificationPreview.droppedCount).toBe(1);
      expect(classificationPreview.failedCount).toBe(1);

      // -- restoreRevisionBatch refuses when the preview reports a ----------
      // failed PROPERTY, writes nothing.
      const pageBeforeFailedRestore = await getPage(handle.db, page.id);
      const failedRestoreError: unknown = await restoreRevisionBatch(
        depsV2,
        superadmin,
        {
          revisionBatchId: rootBatchId,
          pageId: page.id,
          basePageVersion: pageBeforeFailedRestore!.version,
        },
      ).catch((caught: unknown) => caught);
      expect(failedRestoreError).toBeInstanceOf(DegradedRestoreError);
      const pageAfterFailedRestore = await getPage(handle.db, page.id);
      expect(pageAfterFailedRestore!.version).toBe(
        pageBeforeFailedRestore!.version,
      );

      // ---------------------------------------------------------------
      // Block-level degradation: a raw-inserted rollback row (stored
      // schema_version above the current one -- no downcast path, D-10's
      // established adaptation for an otherwise-unreachable degraded case
      // in this phase). Reported with a DegradedReason, restore refuses.
      // ---------------------------------------------------------------
      const rollbackBatchId = randomUUID();
      await handle.sql`
        INSERT INTO block_revisions (
          block_id, owner_type, owner_id, locale, revision_batch_id,
          change_type, kind, block_type, parent_block_id, sort_order,
          depth, props, schema_version, author_id, created_at
        ) VALUES (
          ${root.id}, 'page', ${page.id}, 'en', ${rollbackBatchId},
          'update', 'save', 'card', NULL, ${root.sortOrder}, 0,
          '{"tag":"rollback"}'::jsonb, 99, ${superadminUser.userId},
          ${clock().toISOString()}::timestamptz
        )
      `;
      const degradedPreview = await computeBlockRestorePreview(handle.db, {
        revisionBatchId: rollbackBatchId,
      });
      expect(degradedPreview.blocks[0]?.degradedReason).toBe('above-current');
      expect(
        degradedPreview.blocks[0]?.properties.every(
          (property) => property.status === 'failed',
        ),
      ).toBe(true);

      const pageBeforeDegradedRestore = await getPage(handle.db, page.id);
      const degradedRestoreError: unknown = await restoreRevisionBatch(
        depsV2,
        superadmin,
        {
          revisionBatchId: rollbackBatchId,
          pageId: page.id,
          basePageVersion: pageBeforeDegradedRestore!.version,
        },
      ).catch((caught: unknown) => caught);
      expect(degradedRestoreError).toBeInstanceOf(DegradedRestoreError);
      const pageAfterDegradedRestore = await getPage(handle.db, page.id);
      expect(pageAfterDegradedRestore!.version).toBe(
        pageBeforeDegradedRestore!.version,
      );

      // -- Unregistered block type: reported unknown-block-type -------------
      const ghostBatchId = randomUUID();
      await handle.sql`
        INSERT INTO block_revisions (
          block_id, owner_type, owner_id, locale, revision_batch_id,
          change_type, kind, block_type, parent_block_id, sort_order,
          depth, props, schema_version, author_id, created_at
        ) VALUES (
          NULL, 'page', ${page.id}, 'en', ${ghostBatchId},
          'delete', 'save', 'ghost-block', NULL, 9999, 0,
          '{"whatever":true}'::jsonb, 1, ${superadminUser.userId},
          ${clock().toISOString()}::timestamptz
        )
      `;
      const ghostPreview = await computeBlockRestorePreview(handle.db, {
        revisionBatchId: ghostBatchId,
      });
      expect(ghostPreview.blocks[0]?.degradedReason).toBe('unknown-block-type');
      expect(ghostPreview.blocks[0]?.currentVersion).toBeNull();

      // ---------------------------------------------------------------
      // Placement-illegal restore: re-register `card` so it no longer
      // accepts any children, then attempt to restore the note's ORIGINAL
      // create batch (recorded parentBlockId: root.id) -- refused with the
      // same placement error family a live insert would raise (T-04-36).
      // ---------------------------------------------------------------
      const cardV3NoChildren = {
        ...cardV1,
        placement: { allowedChildren: 'none' as const },
      };
      const configV3 = definePagesConfig({
        content,
        blocks: defineBlocks([cardV3NoChildren, noteV1]),
      });
      const depsV3: PagesDeps = { ...depsV1, config: configV3 };
      const noteCreateBatchId = (
        await handle.sql<{ revisionBatchId: string }[]>`
          SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
          WHERE block_id = ${note.id} AND change_type = 'create'
        `
      )[0]!.revisionBatchId;
      const pageBeforePlacementRestore = await getPage(handle.db, page.id);
      const placementError: unknown = await restoreRevisionBatch(
        depsV3,
        superadmin,
        {
          revisionBatchId: noteCreateBatchId,
          pageId: page.id,
          basePageVersion: pageBeforePlacementRestore!.version,
        },
      ).catch((caught: unknown) => caught);
      expect(placementError).toBeInstanceOf(BlockPlacementError);
      const pageAfterPlacementRestore = await getPage(handle.db, page.id);
      expect(pageAfterPlacementRestore!.version).toBe(
        pageBeforePlacementRestore!.version,
      );

      // ---------------------------------------------------------------
      // Immutability: every PRE-EXISTING block_revisions row's props/
      // schema_version is byte-identical to its snapshot from before any
      // restore ran -- only new rows were added.
      // ---------------------------------------------------------------
      const postRestoreSnapshot = await snapshotAllRevisions(handle);
      const postById = new Map(postRestoreSnapshot.map((row) => [row.id, row]));
      for (const before of preRestoreSnapshot) {
        const after = postById.get(before.id);
        expect(after).toBeDefined();
        expect(after?.propsText).toBe(before.propsText);
        expect(after?.schemaVersion).toBe(before.schemaVersion);
      }
      expect(postRestoreSnapshot.length).toBeGreaterThan(
        preRestoreSnapshot.length,
      );
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });
});

describe("restoreRevisionBatch's 'move' replay enforces the same subtree-height-aware ceilings moveBlock does (code review CR-02)", () => {
  const subtreeRoles = defineRoles({ ...defaultRoles, viewer: ['pages:read'] });

  async function setupSubtreeFixture(): Promise<{
    readonly testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
    readonly handle: Db;
    readonly deps: PagesDeps;
    readonly superadmin: AuditActor;
  }> {
    const testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    const handle = createDb({
      connectionString: testDatabase.connectionString,
    });
    const resolver: PermissionResolver = createPermissionResolver(subtreeRoles);
    const recorder: AuditRecorder = createAuditRecorder({
      db: handle.db,
      resolver,
    });
    const superadminUser = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: `cr02-${randomUUID()}@example.com`,
      name: 'CR-02 Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    const superadmin: AuditActor = {
      userId: superadminUser.userId,
      roleKey: superadminUser.roleKey,
    };
    // Same fixture shape `tree-writes.test.ts` uses for `moveBlock`'s own
    // subtree-height-aware checks -- a low `blockDepthCeiling`/
    // `sectionNestingDepth` makes both cheap to reach, and `wrapper`'s
    // `allowedChildren: 'any'` lets a subtree with real height be built
    // without needing a section at every level.
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
        {
          key: 'heading',
          editor: { label: 'Heading' },
          schemaVersion: 1,
          properties: {},
        },
        {
          key: 'wrapper',
          editor: { label: 'Wrapper' },
          schemaVersion: 1,
          properties: {},
          placement: { allowedChildren: 'any' },
        },
      ]),
      sectionNestingDepth: 2,
      blockDepthCeiling: 4,
    });
    const clock = (): Date => new Date('2026-09-28T12:00:00.000Z');
    const deps: PagesDeps = {
      db: handle.db,
      recorder,
      resolver,
      config,
      now: clock,
    };
    return { testDatabase, handle, deps, superadmin };
  }

  async function blockRow(
    handle: Db,
    blockId: string,
  ): Promise<{
    parentBlockId: string | null;
    depth: number;
    version: number;
  }> {
    const [row] = await handle.sql<
      { parentBlockId: string | null; depth: number; version: number }[]
    >`
      SELECT parent_block_id AS "parentBlockId", depth, version
      FROM page_blocks WHERE id = ${blockId}
    `;
    if (row === undefined) throw new Error(`block ${blockId} not found`);
    return row;
  }

  /** Fabricates a `'move'`-kind `block_revisions` row directly -- the same
   * raw-INSERT technique the suite above already uses for an otherwise-
   * unreachable degraded case (the `rollbackBatchId` fixture): a restore
   * that would breach a ceiling can never be produced by a LIVE `moveBlock`
   * call (it enforces the identical check itself), so the only way to prove
   * a restore refuses the same shape is to record a revision describing a
   * destination that was legal when some other historical move recorded it,
   * then let the live tree drift (gain descendants, in this case) before
   * the restore runs. */
  async function insertFabricatedMoveRevision(
    handle: Db,
    input: {
      readonly blockId: string;
      readonly ownerId: string;
      readonly locale: string;
      readonly blockType: string;
      readonly recordedParentBlockId: string | null;
      readonly recordedDepth: number;
      readonly recordedSortOrder: number;
      readonly authorId: string;
    },
  ): Promise<string> {
    const revisionBatchId = randomUUID();
    await handle.sql`
      INSERT INTO block_revisions (
        block_id, owner_type, owner_id, locale, revision_batch_id,
        change_type, kind, block_type, parent_block_id, sort_order,
        depth, props, schema_version, author_id, created_at
      ) VALUES (
        ${input.blockId}, 'page', ${input.ownerId}, ${input.locale}, ${revisionBatchId},
        'move', 'save', ${input.blockType}, ${input.recordedParentBlockId}, ${input.recordedSortOrder},
        ${input.recordedDepth}, '{}'::jsonb, 1, ${input.authorId},
        '2026-09-28T11:00:00.000Z'::timestamptz
      )
    `;
    return revisionBatchId;
  }

  it("refuses a 'move' restore whose recorded destination, combined with the block's LIVE subtree height, breaches blockDepthCeiling -- even though the block's own resulting depth alone would fit exactly at the ceiling", async () => {
    const { testDatabase, handle, deps, superadmin } =
      await setupSubtreeFixture();
    try {
      const page = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'Depth ceiling restore',
      });
      const ownerRef = {
        ownerType: 'page' as const,
        ownerId: page.id,
        locale: 'en',
      };
      const section = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      let fresh = await getPage(handle.db, page.id);
      const w1 = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'wrapper',
        parentBlockId: section.id,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const w2 = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'wrapper',
        parentBlockId: w1.id,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const w3 = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'wrapper',
        parentBlockId: w2.id,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const wrapperX = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'wrapper',
        parentBlockId: section.id,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const leafY = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'heading',
        parentBlockId: wrapperX.id,
        basePageVersion: fresh!.version,
      });

      const beforeX = await blockRow(handle, wrapperX.id);
      const beforeY = await blockRow(handle, leafY.id);

      // Recorded destination is w3 (depth 3): a single-node check (an
      // insert-equivalent) would approve depth 3 + 1 = 4, exactly the
      // ceiling. wrapperX's LIVE subtree (itself + leafY, height 1) would
      // actually land leafY at depth 5 -- past the ceiling.
      const revisionBatchId = await insertFabricatedMoveRevision(handle, {
        blockId: wrapperX.id,
        ownerId: page.id,
        locale: 'en',
        blockType: 'wrapper',
        recordedParentBlockId: w3.id,
        recordedDepth: 4,
        recordedSortOrder: 1000,
        authorId: superadmin.userId,
      });

      const pageBefore = await getPage(handle.db, page.id);
      const error: unknown = await restoreRevisionBatch(deps, superadmin, {
        revisionBatchId,
        pageId: page.id,
        basePageVersion: pageBefore!.version,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BlockDepthExceededError);
      expect((error as BlockDepthExceededError).ceiling).toBe(4);
      expect((error as BlockDepthExceededError).attempted).toBe(5);

      expect(await blockRow(handle, wrapperX.id)).toEqual(beforeX);
      expect(await blockRow(handle, leafY.id)).toEqual(beforeY);
      const pageAfter = await getPage(handle.db, page.id);
      expect(pageAfter!.version).toBe(pageBefore!.version);
    } finally {
      await handle.close();
      await testDatabase.drop();
    }
  });

  it("refuses a 'move' restore whose recorded destination, combined with the block's LIVE section-only subtree height, breaches sectionNestingDepth", async () => {
    const { testDatabase, handle, deps, superadmin } =
      await setupSubtreeFixture();
    try {
      const page = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'Section cap restore',
      });
      const ownerRef = {
        ownerType: 'page' as const,
        ownerId: page.id,
        locale: 'en',
      };
      const sectionC = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      let fresh = await getPage(handle.db, page.id);
      const sectionA = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const sectionB = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'section',
        parentBlockId: sectionA.id,
        basePageVersion: fresh!.version,
      });

      const beforeA = await blockRow(handle, sectionA.id);
      const beforeB = await blockRow(handle, sectionB.id);

      // sectionA's LIVE subtree already contains a nested section
      // (sectionB), so its own section-height is 2. The recorded
      // destination is sectionC (section-depth 1, inclusive of itself) --
      // a single-node check would approve 1 + 1 = 2, exactly the cap.
      // Restoring the whole live subtree reaches section-depth 3.
      const revisionBatchId = await insertFabricatedMoveRevision(handle, {
        blockId: sectionA.id,
        ownerId: page.id,
        locale: 'en',
        blockType: 'section',
        recordedParentBlockId: sectionC.id,
        recordedDepth: 1,
        recordedSortOrder: 1000,
        authorId: superadmin.userId,
      });

      const pageBefore = await getPage(handle.db, page.id);
      const error: unknown = await restoreRevisionBatch(deps, superadmin, {
        revisionBatchId,
        pageId: page.id,
        basePageVersion: pageBefore!.version,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SectionNestingDepthExceededError);
      expect((error as SectionNestingDepthExceededError).cap).toBe(2);
      expect((error as SectionNestingDepthExceededError).attempted).toBe(3);

      expect(await blockRow(handle, sectionA.id)).toEqual(beforeA);
      expect(await blockRow(handle, sectionB.id)).toEqual(beforeB);
      const pageAfter = await getPage(handle.db, page.id);
      expect(pageAfter!.version).toBe(pageBefore!.version);
    } finally {
      await handle.close();
      await testDatabase.drop();
    }
  });

  it("a 'move' restore recomputes a LIVE descendant's depth relative to the block's RESTORED position, rather than leaving it relative to the pre-restore position", async () => {
    const { testDatabase, handle, deps, superadmin } =
      await setupSubtreeFixture();
    try {
      const page = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'Descendant depth recompute',
      });
      const ownerRef = {
        ownerType: 'page' as const,
        ownerId: page.id,
        locale: 'en',
      };
      const section = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: page.version,
      });
      let fresh = await getPage(handle.db, page.id);
      // A second root section -- `wrapper` is `kind: 'block'`, so it can
      // never sit directly under the page itself (D-19); it needs a
      // section destination to move into.
      const sectionZ = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'section',
        parentBlockId: null,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const wrapperA = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'wrapper',
        parentBlockId: section.id,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const wrapperX = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'wrapper',
        parentBlockId: wrapperA.id,
        basePageVersion: fresh!.version,
      });
      fresh = await getPage(handle.db, page.id);
      const leafY = await insertBlock(deps, superadmin, {
        owner: ownerRef,
        blockType: 'heading',
        parentBlockId: wrapperX.id,
        basePageVersion: fresh!.version,
      });
      expect((await blockRow(handle, wrapperX.id)).depth).toBe(2);
      expect((await blockRow(handle, leafY.id)).depth).toBe(3);

      // Move wrapperX (and leafY with it) to sectionZ -- the 'move'
      // revision this records captures wrapperX's PRE-move state:
      // parentBlockId = wrapperA.id, depth = 2 (restoring this batch later
      // sends wrapperX back there).
      fresh = await getPage(handle.db, page.id);
      const wrapperXBeforeMove = await blockRow(handle, wrapperX.id);
      await moveBlock(deps, superadmin, {
        blockId: wrapperX.id,
        baseVersion: wrapperXBeforeMove.version,
        pageId: page.id,
        basePageVersion: fresh!.version,
        newParentBlockId: sectionZ.id,
      });
      expect((await blockRow(handle, wrapperX.id)).depth).toBe(1);
      expect((await blockRow(handle, leafY.id)).depth).toBe(2);

      const [moveBatchRow] = await handle.sql<{ revisionBatchId: string }[]>`
        SELECT revision_batch_id AS "revisionBatchId" FROM block_revisions
        WHERE block_id = ${wrapperX.id} AND change_type = 'move'
        ORDER BY created_at DESC LIMIT 1
      `;
      const revisionBatchId = moveBatchRow!.revisionBatchId;

      const pageBeforeRestore = await getPage(handle.db, page.id);
      await restoreRevisionBatch(deps, superadmin, {
        revisionBatchId,
        pageId: page.id,
        basePageVersion: pageBeforeRestore!.version,
      });

      const wrapperXAfter = await blockRow(handle, wrapperX.id);
      const leafYAfter = await blockRow(handle, leafY.id);
      expect(wrapperXAfter.parentBlockId).toBe(wrapperA.id);
      expect(wrapperXAfter.depth).toBe(2);
      // CR-02: the pre-fix code only wrote wrapperX's own row (using its
      // recorded historical depth) and never touched leafY -- leafY would
      // stay at depth 1 (its PRE-restore, root-relative depth) instead of
      // being recomputed to depth 3, relative to wrapperX's restored
      // position under wrapperA.
      expect(leafYAfter.depth).toBe(3);
    } finally {
      await handle.close();
      await testDatabase.drop();
    }
  });
});
