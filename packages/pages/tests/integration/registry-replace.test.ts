/**
 * Boot-time replacement compatibility against stored instances (BLOCK-09,
 * D-06, D-15), proven against real Postgres: a replacement that keeps the
 * version lineage keeps every stored row byte-identical and readable
 * through the new schema; one that breaks it refuses at boot naming the
 * key and versions, without touching a single stored row; a deliberately
 * declared floor warns instead of blocking the deploy.
 *
 * D-10 (04-04 Task 1) requires a block's `upcasters` to cover every step
 * from 2..schemaVersion contiguously at declare time, so a genuine
 * "declared a higher schemaVersion but left an upcaster gap" config is now
 * refused by `defineBlocks` itself, before `checkBlockCompatibility` could
 * ever see it -- the same tension already documented in this plan's
 * `tests/unit/versioning.test.ts` and the tracer's own below-floor swap.
 * The reachable `incompatible` scenario this test exercises instead is a
 * rollback: a block instance stored at a `schema_version` ABOVE the
 * currently-declared `schemaVersion` (an older build reading a
 * already-migrated-forward database) has no downcast path by construction,
 * regardless of how complete the declared upcaster chain is.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import {
  assertBlockCompatibility,
  BlockCompatibilityError,
  type BelowFloorEvent,
} from '../../src/compatibility.js';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import { createPage } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, readBlockTree } from '../../src/tree.js';
import { createTestDatabase } from './test-database.js';

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

describe('registry replacement compatibility against stored instances (BLOCK-09, D-06, D-15)', () => {
  it('keeps a compatible replacement fully readable, refuses an incompatible one, and warns for a deliberately declared floor', async () => {
    const testDatabase = await createTestDatabase();
    let handle: Db | undefined;
    try {
      await runMigrations({
        connectionString: testDatabase.connectionString,
      });
      handle = createDb({ connectionString: testDatabase.connectionString });

      const resolver: PermissionResolver =
        createPermissionResolver(defaultRoles);
      const recorder: AuditRecorder = createAuditRecorder({
        db: handle.db,
        resolver,
      });
      const clock = (): Date => new Date('2026-09-25T09:00:00.000Z');

      const superadminUser = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email: 'owner@example.com',
        name: 'Owner',
        roleKey: SUPERADMIN_ROLE_KEY,
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

      // -- Seed: two `card` blocks stored at schemaVersion 1 -------------
      const cardV1 = defineBlocks([
        {
          key: 'card',
          editor: { label: 'Card' },
          schemaVersion: 1,
          properties: {},
        },
      ]);
      const configV1 = definePagesConfig({ content, blocks: cardV1 });
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
        basePageVersion: page.version,
      });
      // `insertBlock` bumps the owning page's version by exactly one per
      // structural change (D-38); `page.version` starts at 1.
      const blockTwo = await insertBlock(depsV1, superadmin, {
        owner,
        blockType: 'card',
        parentBlockId: null,
        basePageVersion: page.version + 1,
      });

      const beforeOne = await snapshotBlock(handle, blockOne.id);
      const beforeTwo = await snapshotBlock(handle, blockTwo.id);
      expect(beforeOne.schemaVersion).toBe(1);
      expect(beforeTwo.schemaVersion).toBe(1);

      const auditCountAfterSeed = await auditLogCount(handle);

      // -- Compatible replacement: card v1 -> v2, upcaster for step 2 ----
      const cardCoreV1 = {
        key: 'card',
        editor: { label: 'Card (core)' },
        schemaVersion: 1,
        properties: {},
      } as const;
      const cardHostV2 = {
        key: 'card',
        editor: { label: 'Card (host)' },
        schemaVersion: 2,
        upcasters: {
          2: (props: unknown) => ({
            ...(props as Record<string, unknown>),
            upgraded: true,
          }),
        },
        properties: {},
      } as const;
      const cardV2 = defineBlocks([cardCoreV1, cardHostV2]);
      const configV2 = definePagesConfig({ content, blocks: cardV2 });
      const depsV2: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config: configV2,
        now: clock,
      };

      await expect(assertBlockCompatibility(depsV2)).resolves.toBeUndefined();

      const afterOne = await snapshotBlock(handle, blockOne.id);
      const afterTwo = await snapshotBlock(handle, blockTwo.id);
      expect(afterOne).toEqual(beforeOne);
      expect(afterTwo).toEqual(beforeTwo);

      const treeAfterUpgrade = await readBlockTree(handle.db, owner);
      for (const node of treeAfterUpgrade) {
        expect(node.degraded).toBe(false);
        expect(node.degraded === false && node.props).toEqual({
          upgraded: true,
        });
      }

      // -- Incompatible replacement: a stored version ABOVE the current --
      // schemaVersion has no downcast path, regardless of upcaster
      // completeness -- this is the reachable `incompatible` case under
      // D-10's contiguous-upcaster-at-declare-time rule (see header
      // comment).
      const [rollbackRow] = await handle.sql<{ id: string }[]>`
        INSERT INTO page_blocks (
          owner_type, owner_id, locale, parent_block_id, block_type, props,
          schema_version, depth, sort_order, version, created_at, updated_at
        ) VALUES (
          'page', ${page.id}, 'en', NULL, 'card', '{}'::jsonb,
          99, 0, 9000, 1, ${clock().toISOString()}::timestamptz, ${clock().toISOString()}::timestamptz
        ) RETURNING id
      `;

      let caught: unknown;
      try {
        await assertBlockCompatibility(depsV2);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlockCompatibilityError);
      const report = (caught as BlockCompatibilityError).report;
      const cardEntry = report.incompatible.find(
        (entry) => entry.blockKey === 'card',
      );
      expect(cardEntry?.storedVersions).toContain(99);
      expect(cardEntry?.currentVersion).toBe(2);
      expect(cardEntry?.missingSteps).toEqual([]);

      const rollbackSnapshot = await snapshotBlock(
        handle,
        rollbackRow?.id ?? '',
      );
      expect(rollbackSnapshot.schemaVersion).toBe(99);
      const afterRefusalOne = await snapshotBlock(handle, blockOne.id);
      expect(afterRefusalOne).toEqual(beforeOne);

      await handle.sql`DELETE FROM page_blocks WHERE id = ${rollbackRow?.id ?? ''}`;

      // -- Deliberately declared floor: warns, never blocks boot ---------
      const [belowFloorRow] = await handle.sql<{ id: string }[]>`
        INSERT INTO page_blocks (
          owner_type, owner_id, locale, parent_block_id, block_type, props,
          schema_version, depth, sort_order, version, created_at, updated_at
        ) VALUES (
          'page', ${page.id}, 'en', NULL, 'note', '{}'::jsonb,
          1, 0, 9500, 1, ${clock().toISOString()}::timestamptz, ${clock().toISOString()}::timestamptz
        ) RETURNING id
      `;

      const noteFloored = {
        key: 'note',
        editor: { label: 'Note' },
        schemaVersion: 3,
        minSupportedVersion: 3,
        upcasters: {
          2: (props: unknown) => props,
          3: (props: unknown) => props,
        },
        properties: {},
      } as const;
      const configV3 = definePagesConfig({
        content,
        blocks: defineBlocks([cardCoreV1, cardHostV2, noteFloored]),
      });

      const belowFloorEvents: BelowFloorEvent[] = [];
      const depsV3: PagesDeps = {
        db: handle.db,
        recorder,
        resolver,
        config: configV3,
        now: clock,
        hooks: {
          onBelowFloor: (event) => {
            belowFloorEvents.push(event);
          },
        },
      };

      await expect(assertBlockCompatibility(depsV3)).resolves.toBeUndefined();
      expect(belowFloorEvents).toHaveLength(1);
      expect(belowFloorEvents[0]?.blockKey).toBe('note');
      expect(belowFloorEvents[0]?.storedVersions).toEqual([1]);
      expect(belowFloorEvents[0]?.instanceCount).toBe(1);

      const belowFloorSnapshot = await snapshotBlock(
        handle,
        belowFloorRow?.id ?? '',
      );
      expect(belowFloorSnapshot.schemaVersion).toBe(1);

      // -- Read-only: checkBlockCompatibility/assertBlockCompatibility ---
      // write nothing -- audit_log is unchanged across every call above.
      const auditCountAfterChecks = await auditLogCount(handle);
      expect(auditCountAfterChecks).toBe(auditCountAfterSeed);
    } finally {
      await handle?.close();
      await testDatabase.drop();
    }
  });
});
