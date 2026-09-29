/**
 * Batch rollup reads (`listPageRevisionBatches`/`listBatchRevisions`) and
 * per-page cap pruning (`pruneBlockRevisions`), proven against real Postgres
 * (D-26, D-28, D-29, T-04-29). Restore preview/apply lives in
 * `tests/integration/revision-restore.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
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
import { createPage } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import {
  listBatchRevisions,
  listPageRevisionBatches,
  pruneBlockRevisions,
} from '../../src/revisions.js';
import {
  deleteBlock,
  insertBlock,
  moveBlock,
  updateBlockProps,
} from '../../src/tree.js';
import { createPageTranslation } from '../../src/translations.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles });

const BASE_TIME = Date.parse('2026-09-25T10:00:00.000Z');

describe('block revision batch rollups and per-page cap pruning (D-26, D-28, D-29)', () => {
  it('rolls up batches, expands them to their revisions, and prunes a page-scoped ranked cap without touching other pages, locales, publishes or manifest-referenced rows', async () => {
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
      const clock = (): Date => new Date(BASE_TIME + tick++ * 1000);

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

      const content = defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'UTC',
      });
      const config = definePagesConfig({
        content,
        blocks: defineBlocks([
          {
            key: 'card',
            kind: 'section',
            editor: { label: 'Card' },
            schemaVersion: 1,
            properties: {
              tag: {
                fieldType: 'short_text',
                label: 'Tag',
                options: { maxLength: 40 },
              },
            },
          },
        ]),
        // root -> child -> grandchild are all `card` sections in this
        // fixture (three levels deep) -- above the default cap of 2.
        sectionNestingDepth: 3,
      });
      const deps: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config,
        now: clock,
      };

      // ---------------------------------------------------------------
      // Fixture: page A (en), one root section block, three property
      // edits (3 save batches of 1 revision each), one move (1 save
      // batch of 1 revision) and a two-block subtree delete (1 save
      // batch of TWO revisions) -- six save batches total, sharing one
      // page, each stamped with a distinct createdAt via the ticking
      // clock so batch ranking is unambiguous.
      // ---------------------------------------------------------------
      const pageA = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'Page A',
      });
      const root = await insertBlock(deps, superadmin, {
        owner: { ownerType: 'page', ownerId: pageA.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'root' },
        basePageVersion: pageA.version,
      });

      let pageVersion = pageA.version + 1; // insertBlock bumped it
      let rootVersion = root.version;

      const edit1 = await updateBlockProps(deps, superadmin, {
        blockId: root.id,
        baseVersion: rootVersion,
        props: { tag: 'edit-1' },
      });
      rootVersion = edit1.version;

      const edit2 = await updateBlockProps(deps, superadmin, {
        blockId: root.id,
        baseVersion: rootVersion,
        props: { tag: 'edit-2' },
      });
      rootVersion = edit2.version;

      const edit3 = await updateBlockProps(deps, superadmin, {
        blockId: root.id,
        baseVersion: rootVersion,
        props: { tag: 'edit-3' },
      });
      rootVersion = edit3.version;

      const moved = await moveBlock(deps, superadmin, {
        blockId: root.id,
        baseVersion: rootVersion,
        pageId: pageA.id,
        basePageVersion: pageVersion,
        newParentBlockId: null,
      });
      rootVersion = moved.version;
      pageVersion += 1;

      const child = await insertBlock(deps, superadmin, {
        owner: { ownerType: 'page', ownerId: pageA.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: root.id,
        props: { tag: 'child' },
        basePageVersion: pageVersion,
      });
      pageVersion += 1;
      await insertBlock(deps, superadmin, {
        owner: { ownerType: 'page', ownerId: pageA.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: child.id,
        props: { tag: 'grandchild' },
        basePageVersion: pageVersion,
      });
      pageVersion += 1;

      // Deleting `child` also removes `grandchild` -- one batch, two
      // delete-kind revisions.
      await deleteBlock(deps, superadmin, {
        blockId: child.id,
        baseVersion: child.version,
        pageId: pageA.id,
        basePageVersion: pageVersion,
      });
      pageVersion += 1;

      // -- listPageRevisionBatches: one row per batch, newest first ------
      // Eight save batches: the root's own create, three property edits,
      // one move, the child's create, the grandchild's create, and one
      // two-revision delete batch for the child+grandchild subtree.
      const batches = await listPageRevisionBatches(handle.db, {
        pageId: pageA.id,
        locale: 'en',
      });
      expect(batches).toHaveLength(8);
      // Newest first.
      for (let i = 0; i < batches.length - 1; i += 1) {
        expect(batches[i]!.createdAt.getTime()).toBeGreaterThan(
          batches[i + 1]!.createdAt.getTime(),
        );
      }
      const deleteBatch = batches[0]!;
      expect(deleteBatch.blockCount).toBe(2);
      expect(deleteBatch.changeTypes).toEqual(['delete']);
      expect(deleteBatch.kind).toBe('save');
      expect(deleteBatch.authorId).toBe(superadminUser.userId);

      const moveBatch = batches.find(
        (batch) => batch.changeTypes[0] === 'move',
      );
      expect(moveBatch?.blockCount).toBe(1);

      // -- listBatchRevisions: expands one batch, ordered created_at/id --
      const deleteBatchRevisions = await listBatchRevisions(handle.db, {
        revisionBatchId: deleteBatch.revisionBatchId,
      });
      expect(deleteBatchRevisions).toHaveLength(2);
      expect(
        deleteBatchRevisions.every(
          (revision) => revision.changeType === 'delete',
        ),
      ).toBe(true);
      expect(
        deleteBatchRevisions.map((revision) => revision.blockType),
      ).toEqual(['card', 'card']);
      expect(
        deleteBatchRevisions.map((revision) => revision.schemaVersion),
      ).toEqual([1, 1]);

      // -- A batch whose blocks have since been deleted still lists, ----
      // with blockId null and blockType/parentBlockId/sortOrder intact.
      for (const revision of deleteBatchRevisions) {
        expect(revision.blockId).toBeNull();
        expect(revision.blockType).toBe('card');
        expect(revision.sortOrder).toBeGreaterThanOrEqual(0);
      }
      expect(deleteBatchRevisions[0]!.parentBlockId).not.toBeNull();

      // ---------------------------------------------------------------
      // Fixture: an unrelated second page (en) and a translated sibling
      // (nl) of page A, each with their own save batches -- proves
      // pruning page A never touches either.
      // ---------------------------------------------------------------
      const pageB = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'Page B',
      });
      await insertBlock(deps, superadmin, {
        owner: { ownerType: 'page', ownerId: pageB.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'b-root' },
        basePageVersion: pageB.version,
      });
      const pageBBatchesBefore = await listPageRevisionBatches(handle.db, {
        pageId: pageB.id,
        locale: 'en',
      });
      expect(pageBBatchesBefore).toHaveLength(1);

      const pageANl = await createPageTranslation(deps, superadmin, {
        pageId: pageA.id,
        locale: 'nl',
      });
      await insertBlock(deps, superadmin, {
        owner: { ownerType: 'page', ownerId: pageANl.id, locale: 'nl' },
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'nl-root' },
        basePageVersion: pageANl.version,
      });
      const pageANlBatchesBefore = await listPageRevisionBatches(handle.db, {
        pageId: pageANl.id,
        locale: 'nl',
      });
      expect(pageANlBatchesBefore).toHaveLength(1);

      // -- cap 0 (uncapped): nothing pruned ------------------------------
      const prunedAtZero = await handle.db.transaction((tx) =>
        pruneBlockRevisions(tx, { pageId: pageA.id, locale: 'en', cap: 0 }),
      );
      expect(prunedAtZero).toBe(0);
      expect(
        await listPageRevisionBatches(handle.db, {
          pageId: pageA.id,
          locale: 'en',
        }),
      ).toHaveLength(8);

      // -- Deliberately reference an OLD save revision (one that would --
      // fall outside a cap of 3) from a hand-inserted page_publications
      // row, simulating a publication whose manifest points at a
      // save-kind revision -- the exclusion is generic over kind, not
      // just over 'publish' rows (those are already excluded from
      // ranking entirely).
      const protectedBatch = batches[batches.length - 2]!; // 2nd oldest -- would be pruned at cap 3
      const protectedRevisions = await listBatchRevisions(handle.db, {
        revisionBatchId: protectedBatch.revisionBatchId,
      });
      const protectedRevisionId = protectedRevisions[0]!.id;
      await handle.sql`
        INSERT INTO page_publications (
          page_id, locale, is_draft, snapshot, revision_manifest,
          manifest_hash, published_by, published_at
        ) VALUES (
          ${pageA.id}, 'en', false, '{"blocks":[]}'::jsonb,
          ${`{"some-block-id":"${protectedRevisionId}"}`}::jsonb,
          'manual-fixture-hash', ${superadminUser.userId},
          ${clock().toISOString()}::timestamptz
        )
      `;

      // -- cap 3: keeps the newest 3 batches, deletes the rest ----------
      // EXCEPT the manifest-referenced one, which survives regardless of
      // rank.
      const prunedAtThree = await handle.db.transaction((tx) =>
        pruneBlockRevisions(tx, { pageId: pageA.id, locale: 'en', cap: 3 }),
      );
      // 8 batches -> newest 3 kept unconditionally; of the remaining 5,
      // one (protectedBatch) is spared by the manifest -- the other 4
      // batches (each holding exactly 1 revision) are actually deleted.
      expect(prunedAtThree).toBe(4);

      const batchesAfterPrune = await listPageRevisionBatches(handle.db, {
        pageId: pageA.id,
        locale: 'en',
      });
      const survivingIds = new Set(
        batchesAfterPrune.map((batch) => batch.revisionBatchId),
      );
      expect(survivingIds.size).toBe(4); // newest 3 + the protected one
      expect(survivingIds.has(protectedBatch.revisionBatchId)).toBe(true);
      for (const batch of batches.slice(0, 3)) {
        expect(survivingIds.has(batch.revisionBatchId)).toBe(true);
      }

      // -- Other pages/locales entirely untouched by pruning page A -----
      expect(
        await listPageRevisionBatches(handle.db, {
          pageId: pageB.id,
          locale: 'en',
        }),
      ).toHaveLength(1);
      expect(
        await listPageRevisionBatches(handle.db, {
          pageId: pageANl.id,
          locale: 'nl',
        }),
      ).toHaveLength(1);
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });

  it('publish-kind batches are never counted against the cap or removed, even when far older than every save batch', async () => {
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
      const clock = (): Date => new Date(BASE_TIME + tick++ * 1000);

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner2@example.com',
        name: 'Owner Two',
        roleKey: 'superadmin',
      });
      const superadmin: AuditActor = {
        userId: superadminUser.userId,
        roleKey: superadminUser.roleKey,
      };

      const content = defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      });
      const config = definePagesConfig({
        content,
        blocks: defineBlocks([
          {
            key: 'card',
            kind: 'section',
            editor: { label: 'Card' },
            schemaVersion: 1,
            properties: {
              tag: { fieldType: 'short_text', label: 'Tag' },
            },
          },
        ]),
      });
      const deps: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config,
        now: clock,
      };

      const page = await createPage(deps, superadmin, {
        locale: 'en',
        title: 'Publish scoping',
      });
      const root = await insertBlock(deps, superadmin, {
        owner: { ownerType: 'page', ownerId: page.id, locale: 'en' },
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'v1' },
        basePageVersion: page.version,
      });

      // One OLD, hand-inserted publish-kind batch (predates every save
      // batch below, would rank far outside any cap if it were counted).
      const oldPublishBatchId = randomUUID();
      await handle.sql`
        INSERT INTO block_revisions (
          block_id, owner_type, owner_id, locale, revision_batch_id,
          change_type, kind, block_type, parent_block_id, sort_order,
          depth, props, schema_version, author_id, created_at
        ) VALUES (
          ${root.id}, 'page', ${page.id}, 'en', ${oldPublishBatchId},
          'update', 'publish', 'card', NULL, ${root.sortOrder}, 0,
          '{"tag":"v1"}'::jsonb, 1, ${superadminUser.userId},
          ${new Date(BASE_TIME - 1_000_000).toISOString()}::timestamptz
        )
      `;

      let rootVersion = root.version;
      for (let i = 0; i < 4; i += 1) {
        const updated = await updateBlockProps(deps, superadmin, {
          blockId: root.id,
          baseVersion: rootVersion,
          props: { tag: `edit-${i}` },
        });
        rootVersion = updated.version;
      }

      const batchesBefore = await listPageRevisionBatches(handle.db, {
        pageId: page.id,
        locale: 'en',
      });
      // The root's own create batch + 4 edit batches = 5 save batches,
      // plus the one hand-inserted publish batch.
      expect(batchesBefore).toHaveLength(6);

      const pruned = await handle.db.transaction((tx) =>
        pruneBlockRevisions(tx, { pageId: page.id, locale: 'en', cap: 1 }),
      );
      // Only save batches are ranked/pruned: 5 save batches, cap 1 ->
      // 4 deleted; the publish batch is untouched regardless of age/rank.
      expect(pruned).toBe(4);

      const batchesAfter = await listPageRevisionBatches(handle.db, {
        pageId: page.id,
        locale: 'en',
      });
      expect(batchesAfter).toHaveLength(2); // newest save + the publish batch
      const survivingKinds = batchesAfter.map((batch) => batch.kind).sort();
      expect(survivingKinds).toEqual(['publish', 'save']);
      expect(
        batchesAfter.some(
          (batch) => batch.revisionBatchId === oldPublishBatchId,
        ),
      ).toBe(true);
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });
});
