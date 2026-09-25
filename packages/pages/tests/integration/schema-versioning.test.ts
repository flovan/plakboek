/**
 * Old-schema instances loading, degrading and compacting, proven against
 * real Postgres (BLOCK-12, D-11, D-13, D-14, D-15).
 *
 * D-10 (04-04 Task 1) requires a block's `upcasters` to cover every step
 * from 2..schemaVersion contiguously at declare time, so `defineBlocks`
 * itself refuses a declared gap before any read/compaction code could ever
 * see one -- the same tension already documented in this plan's own
 * `tests/unit/versioning.test.ts`, and in `tests/integration/registry-
 * replace.test.ts` and `tests/unit/compatibility.test.ts` from 04-04. The
 * `'no-upcaster'` reason stays fully covered at the unit level (hand-built
 * `BlockDefinition`s, no registry); the two scenarios this suite's own plan
 * text describes as "definition with only step 3" are adapted here to a
 * raw-inserted stored version ABOVE the current `schemaVersion` (a
 * rollback, reason `'above-current'`) -- reachable regardless of upcaster
 * completeness, and the plan's own documented "no downcast path" case.
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
import {
  compactBlockType,
  computeCompactionImpact,
  reportBelowFloorBlocks,
} from '../../src/compaction.js';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, readBlockTree } from '../../src/tree.js';
import type { DegradedBlockEvent } from '../../src/versioning.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
});

type StoredBlockSnapshot = {
  readonly propsText: string | undefined;
  readonly schemaVersion: number | undefined;
  readonly version: number | undefined;
};

async function snapshotBlock(
  handle: Db,
  blockId: string,
): Promise<StoredBlockSnapshot> {
  const [row] = await handle.sql<
    { propsText: string; schemaVersion: number; version: number }[]
  >`
    SELECT props::text AS "propsText", schema_version AS "schemaVersion", version
    FROM page_blocks WHERE id = ${blockId}
  `;
  return {
    propsText: row?.propsText,
    schemaVersion: row?.schemaVersion,
    version: row?.version,
  };
}

async function auditLogCount(handle: Db): Promise<number> {
  const [row] = await handle.sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM audit_log
  `;
  return Number(row?.count ?? '0');
}

describe('old-schema block instances: loading, degrading and compacting against real Postgres (BLOCK-12, D-11, D-13, D-14, D-15)', () => {
  it('upcasts on read without rewriting storage, degrades every failure mode with a named reason, and lets an audited compaction rewrite what it can prove it can', async () => {
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
      const clock = (): Date => new Date('2026-09-25T10:00:00.000Z');

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: SUPERADMIN_ROLE_KEY,
      });
      const viewerUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'viewer@example.com',
        name: 'Viewer',
        roleKey: 'viewer',
      });
      const superadmin: AuditActor = {
        userId: superadminUser.userId,
        roleKey: superadminUser.roleKey,
      };
      const viewer: AuditActor = {
        userId: viewerUser.userId,
        roleKey: viewerUser.roleKey,
      };

      const content = defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'UTC',
      });

      const cardV1 = {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 1,
        properties: {
          tag: {
            fieldType: 'short_text',
            label: 'Tag',
            options: { maxLength: 20 },
          },
        },
      } as const;
      // The v3 upcasters add `step2`/`step3` markers to prove ordering --
      // declared here so `validateBlockProps` (run by `compactBlockType`
      // before any write) accepts the upcast shape rather than rejecting
      // the added keys as UNKNOWN.
      const cardV3Properties = {
        tag: cardV1.properties.tag,
        step2: { fieldType: 'boolean', label: 'Step 2', required: false },
        step3: { fieldType: 'boolean', label: 'Step 3', required: false },
      } as const;
      const configV1 = definePagesConfig({
        content,
        blocks: defineBlocks([cardV1]),
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
        title: 'Home',
      });
      const owner = {
        ownerType: 'page' as const,
        ownerId: page.id,
        locale: 'en',
      };

      const blockOne = await insertBlock(depsV1, superadmin, {
        owner,
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'ok' },
        basePageVersion: page.version,
      });
      const blockTwo = await insertBlock(depsV1, superadmin, {
        owner,
        blockType: 'card',
        parentBlockId: null,
        props: { tag: 'bad' },
        basePageVersion: page.version + 1,
      });

      const beforeOne = await snapshotBlock(handle, blockOne.id);
      const beforeTwo = await snapshotBlock(handle, blockTwo.id);
      expect(beforeOne.schemaVersion).toBe(1);
      expect(beforeTwo.schemaVersion).toBe(1);

      // -- Scenario A: full contiguous chain, both rows non-degraded, ----
      // stored bytes untouched by the read (D-11).
      const cardV3Clean = {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 3,
        properties: cardV3Properties,
        upcasters: {
          2: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            step2: true,
          }),
          3: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            step3: true,
          }),
        },
      } as const;
      definePagesConfig({ content, blocks: defineBlocks([cardV3Clean]) });

      const degradedEventsA: DegradedBlockEvent[] = [];
      const treeA = await readBlockTree(handle.db, owner, {
        onDegradedBlock: (event) => degradedEventsA.push(event),
      });
      expect(treeA).toHaveLength(2);
      for (const node of treeA) {
        expect(node.degraded).toBe(false);
        expect(node.degraded === false && node.props).toMatchObject({
          step2: true,
          step3: true,
        });
      }
      expect(degradedEventsA).toHaveLength(0);
      expect(await snapshotBlock(handle, blockOne.id)).toEqual(beforeOne);
      expect(await snapshotBlock(handle, blockTwo.id)).toEqual(beforeTwo);

      // -- Scenario B: an upcaster throws for one row's props, the other --
      // resolves normally in the same read (per-row containment).
      const cardV3Throwing = {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 3,
        properties: cardV3Properties,
        upcasters: {
          2: (props: unknown) => {
            if ((props as Record<string, unknown>).tag === 'bad') {
              throw new Error('bad tag');
            }
            return { ...(props as Record<string, unknown>), step2: true };
          },
          3: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            step3: true,
          }),
        },
      } as const;
      definePagesConfig({ content, blocks: defineBlocks([cardV3Throwing]) });

      const degradedEventsB: DegradedBlockEvent[] = [];
      const treeB = await readBlockTree(handle.db, owner, {
        onDegradedBlock: (event) => degradedEventsB.push(event),
      });
      const nodeOneB = treeB.find((node) => node.id === blockOne.id);
      const nodeTwoB = treeB.find((node) => node.id === blockTwo.id);
      expect(nodeOneB?.degraded).toBe(false);
      expect(nodeTwoB?.degraded).toBe(true);
      expect(
        nodeTwoB?.degraded === true ? nodeTwoB.degradedReason : undefined,
      ).toBe('upcaster-threw');
      expect(degradedEventsB).toHaveLength(1);
      expect(degradedEventsB[0]?.blockId).toBe(blockTwo.id);
      expect(degradedEventsB[0]?.reason).toBe('upcaster-threw');
      expect(degradedEventsB[0]?.detail).toContain('bad tag');
      expect(await snapshotBlock(handle, blockOne.id)).toEqual(beforeOne);
      expect(await snapshotBlock(handle, blockTwo.id)).toEqual(beforeTwo);

      // -- Adapted no-upcaster scenario: a rolled-back stored version -----
      // (above the current schemaVersion, no downcast path) degrades with
      // 'above-current' -- reachable regardless of upcaster completeness,
      // unlike a genuinely declared gap (D-10 makes that unreachable
      // through any `defineBlocks`-validated config; see header comment).
      const [rollbackRow] = await handle.sql<{ id: string }[]>`
        INSERT INTO page_blocks (
          owner_type, owner_id, locale, parent_block_id, block_type, props,
          schema_version, depth, sort_order, version, created_at, updated_at
        ) VALUES (
          'page', ${page.id}, 'en', NULL, 'card', '{"tag":"rollback"}'::jsonb,
          99, 0, 9000, 1, ${clock().toISOString()}::timestamptz, ${clock().toISOString()}::timestamptz
        ) RETURNING id
      `;
      definePagesConfig({ content, blocks: defineBlocks([cardV3Clean]) });
      const degradedEventsGap: DegradedBlockEvent[] = [];
      const treeGap = await readBlockTree(handle.db, owner, {
        onDegradedBlock: (event) => degradedEventsGap.push(event),
      });
      const rollbackNode = treeGap.find((node) => node.id === rollbackRow?.id);
      expect(rollbackNode?.degraded).toBe(true);
      expect(
        rollbackNode?.degraded === true
          ? rollbackNode.degradedReason
          : undefined,
      ).toBe('above-current');
      expect(degradedEventsGap).toHaveLength(1);
      const rollbackSnapshotBefore = await snapshotBlock(
        handle,
        rollbackRow?.id ?? '',
      );
      expect(rollbackSnapshotBefore.schemaVersion).toBe(99);
      await handle.sql`DELETE FROM page_blocks WHERE id = ${rollbackRow?.id ?? ''}`;

      // -- Scenario C: a deliberately declared floor degrades every row, --
      // and reportBelowFloorBlocks reports the block type ONCE (grouped),
      // never throwing.
      const cardV3Floored = {
        key: 'card',
        kind: 'section',
        editor: { label: 'Card' },
        schemaVersion: 3,
        minSupportedVersion: 3,
        properties: cardV3Properties,
        upcasters: {
          2: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            step2: true,
          }),
          3: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            step3: true,
          }),
        },
      } as const;
      const configV3Floored = definePagesConfig({
        content,
        blocks: defineBlocks([cardV3Floored]),
      });
      const depsV3Floored: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config: configV3Floored,
        now: clock,
      };

      const degradedEventsC: DegradedBlockEvent[] = [];
      const treeC = await readBlockTree(handle.db, owner, {
        onDegradedBlock: (event) => degradedEventsC.push(event),
      });
      expect(treeC).toHaveLength(2);
      for (const node of treeC) {
        expect(node.degraded).toBe(true);
        expect(node.degraded === true && node.degradedReason).toBe(
          'below-floor',
        );
      }
      expect(degradedEventsC).toHaveLength(2);

      const belowFloorEvents: {
        readonly blockKey: string;
        readonly instanceCount: number;
      }[] = [];
      await expect(
        reportBelowFloorBlocks({
          ...depsV3Floored,
          hooks: {
            onBelowFloor: (event) => belowFloorEvents.push(event),
          },
        }),
      ).resolves.toBeUndefined();
      expect(belowFloorEvents).toHaveLength(1);
      expect(belowFloorEvents[0]?.blockKey).toBe('card');
      expect(belowFloorEvents[0]?.instanceCount).toBe(2);
      expect(await snapshotBlock(handle, blockOne.id)).toEqual(beforeOne);
      expect(await snapshotBlock(handle, blockTwo.id)).toEqual(beforeTwo);

      // -- Back to the clean, full-chain registration for the compaction --
      // scenarios below.
      const configV3 = definePagesConfig({
        content,
        blocks: defineBlocks([cardV3Clean]),
      });
      const depsV3: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config: configV3,
        now: clock,
      };

      // -- Scenario D: computeCompactionImpact is read-only. -------------
      const auditCountBeforeImpact = await auditLogCount(handle);
      const impact = await computeCompactionImpact(handle.db, 'card');
      expect(impact.currentVersion).toBe(3);
      expect(impact.byStoredVersion).toEqual([
        { version: 1, instanceCount: 2, upcastable: true },
      ]);
      expect(impact.upcastableCount).toBe(2);
      expect(impact.blockedCount).toBe(0);
      expect(await auditLogCount(handle)).toBe(auditCountBeforeImpact);

      // -- Scenario E: compactBlockType rewrites both rows through one ---
      // audited, revision-recording batch.
      const compaction = await compactBlockType(depsV3, superadmin, {
        blockKey: 'card',
      });
      expect(compaction.rewritten).toBe(2);
      expect(compaction.skipped).toEqual([]);
      expect(compaction.batches).toBe(1);

      const afterOne = await snapshotBlock(handle, blockOne.id);
      const afterTwo = await snapshotBlock(handle, blockTwo.id);
      expect(afterOne.schemaVersion).toBe(3);
      expect(afterTwo.schemaVersion).toBe(3);
      expect(afterOne.version).toBe((beforeOne.version ?? 0) + 1);
      expect(afterTwo.version).toBe((beforeTwo.version ?? 0) + 1);
      expect(JSON.parse(afterOne.propsText ?? '{}')).toMatchObject({
        tag: 'ok',
        step2: true,
        step3: true,
      });
      expect(JSON.parse(afterTwo.propsText ?? '{}')).toMatchObject({
        tag: 'bad',
        step2: true,
        step3: true,
      });

      const [revisionRow] = await handle.sql<
        { revisionBatchId: string; count: string }[]
      >`
        SELECT revision_batch_id AS "revisionBatchId", count(*)::text AS count
        FROM block_revisions
        WHERE block_id IN (${blockOne.id}, ${blockTwo.id})
          AND change_type = 'update' AND kind = 'save'
        GROUP BY revision_batch_id
      `;
      expect(revisionRow?.count).toBe('2');

      const [compactAuditRow] = await handle.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'block.compact' AND outcome = 'allowed'
      `;
      expect(compactAuditRow?.count).toBe('1');

      const treeAfterCompaction = await readBlockTree(handle.db, owner);
      expect(treeAfterCompaction).toHaveLength(2);
      for (const node of treeAfterCompaction) {
        expect(node.degraded).toBe(false);
      }

      // -- Adapted no-upcaster skip scenario: a fresh rollback row is ----
      // left untouched, named in `skipped`, and the run still writes
      // exactly one MORE audit row.
      const [secondRollbackRow] = await handle.sql<{ id: string }[]>`
        INSERT INTO page_blocks (
          owner_type, owner_id, locale, parent_block_id, block_type, props,
          schema_version, depth, sort_order, version, created_at, updated_at
        ) VALUES (
          'page', ${page.id}, 'en', NULL, 'card', '{"tag":"rollback-2"}'::jsonb,
          99, 0, 9100, 1, ${clock().toISOString()}::timestamptz, ${clock().toISOString()}::timestamptz
        ) RETURNING id
      `;
      const skipCompaction = await compactBlockType(depsV3, superadmin, {
        blockKey: 'card',
      });
      expect(skipCompaction.rewritten).toBe(0);
      expect(skipCompaction.skipped).toEqual([
        {
          blockId: secondRollbackRow?.id,
          storedVersion: 99,
          reason: 'above-current',
        },
      ]);
      const rollbackAfterSkip = await snapshotBlock(
        handle,
        secondRollbackRow?.id ?? '',
      );
      expect(rollbackAfterSkip.schemaVersion).toBe(99);
      const [compactAuditRowAfterSkip] = await handle.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'block.compact' AND outcome = 'allowed'
      `;
      expect(compactAuditRowAfterSkip?.count).toBe('2');
      await handle.sql`DELETE FROM page_blocks WHERE id = ${secondRollbackRow?.id ?? ''}`;

      // -- Scenario G: keyset pagination is real -- batchSize: 1 over ----
      // three rows reports batches: 3 and rewrites all three.
      const freshRowIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const [freshRow] = await handle.sql<{ id: string }[]>`
          INSERT INTO page_blocks (
            owner_type, owner_id, locale, parent_block_id, block_type, props,
            schema_version, depth, sort_order, version, created_at, updated_at
          ) VALUES (
            'page', ${page.id}, 'en', NULL, 'card', ${`{"tag":"fresh-${i}"}`}::jsonb,
            1, 0, ${9200 + i}, 1, ${clock().toISOString()}::timestamptz, ${clock().toISOString()}::timestamptz
          ) RETURNING id
        `;
        if (freshRow !== undefined) freshRowIds.push(freshRow.id);
      }
      expect(freshRowIds).toHaveLength(3);
      const batchedCompaction = await compactBlockType(depsV3, superadmin, {
        blockKey: 'card',
        batchSize: 1,
      });
      expect(batchedCompaction.batches).toBe(3);
      expect(batchedCompaction.rewritten).toBe(3);
      for (const id of freshRowIds) {
        const snapshot = await snapshotBlock(handle, id);
        expect(snapshot.schemaVersion).toBe(3);
      }

      // -- Scenario H: an actor holding no pages:edit is refused, and a --
      // denied audit row exists.
      const deniedError: unknown = await compactBlockType(depsV3, viewer, {
        blockKey: 'card',
      }).catch((caught: unknown) => caught);
      expect(deniedError).toBeInstanceOf(PermissionDeniedError);
      const [deniedAuditRow] = await handle.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM audit_log
        WHERE action = 'block.compact' AND outcome = 'denied'
      `;
      expect(deniedAuditRow?.count).toBe('1');
    } finally {
      if (handle !== undefined) await handle.close();
      await testDatabase.drop();
    }
  });
});
