/**
 * Bringing existing trees into the column shape (D-03). Every section holds
 * columns and every other block lives inside a column, but trees written
 * before the column kind existed have blocks directly under their sections.
 * Two things make those trees uniform without losing anything:
 *
 * - `upgradeSectionColumns` / `upgradeAllSectionColumns` rewrite the stored
 *   working tree: each section that holds a non-column child (or nothing at
 *   all) gets one new column, its non-column children move into it in their
 *   existing order, and every block below them sits one level deeper.
 * - `normaliseSnapshotColumns` does the same to a published snapshot while a
 *   visitor page is resolved, in memory. A published snapshot is immutable
 *   and its manifest hash covers what was published, so it is never
 *   rewritten: old publications simply render on the column grid until the
 *   page is published again.
 *
 * Both are no-ops when the registry declares no column kind.
 */
import { getRevisionCap } from '@plakboek/content';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import {
  newRevisionBatchId,
  pruneBlockRevisions,
  recordBlockRevision,
} from './revisions.js';
import type { SnapshotBlock } from './publish.js';
import {
  getBlockDefinition,
  getColumnDefinition,
  listBlockDefinitions,
  type BlockDefinition,
} from './registry.js';
import { pageBlocks, pages } from './schema.js';
import { readStoredLayout } from './layout.js';

/** Where the one column a section gains sorts among its (non-column)
 * children's own orders, which it does not touch. */
const NEW_COLUMN_SORT_ORDER = 1000;

/** Default number of pages `upgradeAllSectionColumns` upgrades per call. */
const DEFAULT_UPGRADE_BATCH_SIZE = 50;

/** The kind of a block type, or null when it is not registered: a block the
 * registry no longer knows is left exactly as it is. */
function kindOf(blockType: string): BlockDefinition['kind'] | null {
  try {
    return getBlockDefinition(blockType).kind;
  } catch {
    return null;
  }
}

type StoredBlock = typeof pageBlocks.$inferSelect;

/**
 * Upgrades one page's working tree to the column shape. A no-op, with no
 * query at all, when the registry has no column kind.
 *
 * In one transaction under a per-page advisory lock (two runs on the same
 * page serialise; the second finds nothing left to do) and with the page row
 * locked `FOR UPDATE`: every section that holds a non-column child, or no
 * child, gets one new empty-props column. Its non-column children move into
 * the column keeping their sort orders, and every block in those subtrees
 * moves one level deeper. The change is recorded as one revision batch
 * (a create for each new column, a move for each re-parented child holding
 * its pre-move parent and depth) with no author, and the page version is
 * bumped once. Running it again changes nothing. A page that no longer
 * exists is skipped silently.
 *
 * A system data migration with no acting user, so it is not audited and
 * writes no audit row. It never publishes and never purges a cache: what
 * visitors see is the published snapshot, normalised on read
 * (`normaliseSnapshotColumns`); the page simply shows pending changes until
 * it is published again.
 */
export async function upgradeSectionColumns(
  deps: PagesDeps,
  input: { readonly pageId: string },
): Promise<{
  /** True when this call changed the page's tree. */
  readonly upgraded: boolean;
  /** The page's version after the upgrade; null when nothing changed. */
  readonly pageVersion: number | null;
}> {
  const column = getColumnDefinition();
  if (column === null) return { upgraded: false, pageVersion: null };

  const now = (deps.now ?? (() => new Date()))();
  const revisionCap = await getRevisionCap(deps.db);

  return await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('plakboek:section-columns:' || ${input.pageId}))`,
    );

    const [page] = await tx
      .select({ id: pages.id, locale: pages.locale, version: pages.version })
      .from(pages)
      .where(eq(pages.id, input.pageId))
      .for('update');
    if (page === undefined) return { upgraded: false, pageVersion: null };

    const rows = await tx
      .select()
      .from(pageBlocks)
      .where(
        and(
          eq(pageBlocks.ownerType, 'page'),
          eq(pageBlocks.ownerId, page.id),
          eq(pageBlocks.locale, page.locale),
        ),
      );

    const childrenOf = new Map<string | null, StoredBlock[]>();
    for (const row of rows) {
      const siblings = childrenOf.get(row.parentBlockId) ?? [];
      siblings.push(row);
      childrenOf.set(row.parentBlockId, siblings);
    }

    // Sections that need a column: no child, or a child that is no column.
    const upgraded = new Map<string, string>();
    for (const row of rows) {
      if (kindOf(row.blockType) !== 'section') continue;
      const children = childrenOf.get(row.id) ?? [];
      if (
        children.length === 0 ||
        children.some((child) => child.blockType !== column.key)
      ) {
        upgraded.set(row.id, randomUUID());
      }
    }
    if (upgraded.size === 0) return { upgraded: false, pageVersion: null };

    // Walk the tree once to find where every block ends up. A block below an
    // upgraded section's non-column child sits one level deeper per such
    // ancestor; the new column sits just under its section's final depth.
    const finalDepths = new Map<string, number>();
    const newColumns: {
      id: string;
      sectionId: string;
      depth: number;
    }[] = [];
    const reparented: { block: StoredBlock; columnId: string }[] = [];
    const pending: { block: StoredBlock; shift: number }[] = (
      childrenOf.get(null) ?? []
    ).map((block) => ({ block, shift: 0 }));
    for (
      let entry = pending.pop();
      entry !== undefined;
      entry = pending.pop()
    ) {
      const { block, shift } = entry;
      const finalDepth = block.depth + shift;
      if (finalDepth !== block.depth) finalDepths.set(block.id, finalDepth);
      const columnId = upgraded.get(block.id);
      if (columnId !== undefined) {
        newColumns.push({
          id: columnId,
          sectionId: block.id,
          depth: finalDepth + 1,
        });
      }
      for (const child of childrenOf.get(block.id) ?? []) {
        const moves = columnId !== undefined && child.blockType !== column.key;
        if (moves) reparented.push({ block: child, columnId });
        pending.push({ block: child, shift: shift + (moves ? 1 : 0) });
      }
    }

    if (newColumns.length === 0) return { upgraded: false, pageVersion: null };

    await tx.insert(pageBlocks).values(
      newColumns.map((entry) => ({
        id: entry.id,
        ownerType: 'page',
        ownerId: page.id,
        locale: page.locale,
        parentBlockId: entry.sectionId,
        blockType: column.key,
        props: {},
        layout: null,
        schemaVersion: column.schemaVersion,
        depth: entry.depth,
        sortOrder: NEW_COLUMN_SORT_ORDER,
        version: 1,
        createdBy: null,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
      })),
    );

    if (reparented.length > 0) {
      const parentValues = sql.join(
        reparented.map(
          (entry) => sql`(${entry.block.id}::uuid, ${entry.columnId}::uuid)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE page_blocks
        SET parent_block_id = v.new_parent, version = page_blocks.version + 1,
          updated_at = ${now.toISOString()}::timestamptz
        FROM (VALUES ${parentValues}) AS v(id, new_parent)
        WHERE page_blocks.id = v.id
      `);
    }

    if (finalDepths.size > 0) {
      const depthValues = sql.join(
        [...finalDepths].map(
          ([id, depth]) => sql`(${id}::uuid, ${depth}::integer)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE page_blocks SET depth = v.new_depth
        FROM (VALUES ${depthValues}) AS v(id, new_depth)
        WHERE page_blocks.id = v.id
      `);
    }

    const owner = {
      ownerType: 'page',
      ownerId: page.id,
      locale: page.locale,
    } as const;
    const revisionBatchId = newRevisionBatchId();
    for (const entry of newColumns) {
      await recordBlockRevision(tx, {
        blockId: entry.id,
        owner,
        revisionBatchId,
        changeType: 'create',
        kind: 'save',
        blockType: column.key,
        parentBlockId: entry.sectionId,
        sortOrder: NEW_COLUMN_SORT_ORDER,
        depth: entry.depth,
        props: {},
        layout: null,
        schemaVersion: column.schemaVersion,
        authorId: null,
        createdAt: now,
      });
    }
    for (const { block } of reparented) {
      await recordBlockRevision(tx, {
        blockId: block.id,
        owner,
        revisionBatchId,
        changeType: 'move',
        kind: 'save',
        blockType: block.blockType,
        parentBlockId: block.parentBlockId,
        sortOrder: block.sortOrder,
        depth: block.depth,
        props: block.props,
        layout: readStoredLayout(block.layout),
        schemaVersion: block.schemaVersion,
        authorId: null,
        createdAt: now,
      });
    }

    await tx
      .update(pages)
      .set({ version: sql`${pages.version} + 1` })
      .where(eq(pages.id, page.id));
    await pruneBlockRevisions(tx, {
      pageId: page.id,
      locale: page.locale,
      cap: revisionCap,
    });

    return { upgraded: true, pageVersion: page.version + 1 };
  });
}

/**
 * Upgrades every page that still needs it, at most `batchSize` (default 50)
 * per call: one query finds the candidate pages (those with a section
 * holding a non-column child or no child), then each is upgraded in its own
 * short transaction. Returns how many pages were examined and how many
 * changed; call again while `upgraded` is above zero. A no-op without a
 * column kind.
 */
export async function upgradeAllSectionColumns(
  deps: PagesDeps,
  options: { readonly batchSize?: number } = {},
): Promise<{ readonly pages: number; readonly upgraded: number }> {
  const column = getColumnDefinition();
  const sectionKeys = listBlockDefinitions()
    .filter((definition) => definition.kind === 'section')
    .map((definition) => definition.key);
  if (column === null || sectionKeys.length === 0) {
    return { pages: 0, upgraded: 0 };
  }
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? DEFAULT_UPGRADE_BATCH_SIZE),
  );

  const result: unknown = await deps.db.execute(sql`
    SELECT DISTINCT s.owner_id AS "pageId"
    FROM page_blocks s
    JOIN pages p ON p.id = s.owner_id AND p.locale = s.locale
    WHERE s.owner_type = 'page'
      AND s.block_type IN (${sql.join(
        sectionKeys.map((key) => sql`${key}`),
        sql`, `,
      )})
      AND (
        NOT EXISTS (
          SELECT 1 FROM page_blocks c WHERE c.parent_block_id = s.id
        )
        OR EXISTS (
          SELECT 1 FROM page_blocks c
          WHERE c.parent_block_id = s.id AND c.block_type <> ${column.key}
        )
      )
    ORDER BY 1
    LIMIT ${batchSize}
  `);
  const candidateIds: string[] = [];
  for (const row of resultRows(result)) {
    const pageId: unknown = row.pageId;
    if (typeof pageId === 'string') candidateIds.push(pageId);
  }

  let upgradedCount = 0;
  for (const pageId of candidateIds) {
    const outcome = await upgradeSectionColumns(deps, { pageId });
    if (outcome.upgraded) upgradedCount += 1;
  }
  return { pages: candidateIds.length, upgraded: upgradedCount };
}

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. */
function resultRows(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (typeof result === 'object' && result !== null) {
    const rows: unknown = Reflect.get(result, 'rows');
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/**
 * Wraps, in memory, every section's non-column children of a published
 * snapshot in one synthetic column (`<sectionId>:column`, the column
 * definition's schema version, no props), recursing through the whole tree,
 * so a snapshot published before the column kind existed renders on the
 * column grid. The wrapper sits where the first wrapped child was. A section
 * that already holds only columns, and a registry with no column kind, leave
 * the input untouched: the same array is returned when nothing changed.
 * The stored snapshot and its manifest hash are never rewritten.
 */
export function normaliseSnapshotColumns(
  blocks: readonly SnapshotBlock[],
): readonly SnapshotBlock[] {
  const column = getColumnDefinition();
  if (column === null) return blocks;

  const normaliseList = (
    list: readonly SnapshotBlock[],
  ): readonly SnapshotBlock[] => {
    let changed = false;
    const next = list.map((block) => {
      const normalised = normaliseBlock(block);
      if (normalised !== block) changed = true;
      return normalised;
    });
    return changed ? next : list;
  };

  const normaliseBlock = (block: SnapshotBlock): SnapshotBlock => {
    const children = normaliseList(block.children);
    if (
      kindOf(block.blockType) !== 'section' ||
      children.every((child) => child.blockType === column.key)
    ) {
      return children === block.children ? block : { ...block, children };
    }

    const wrapped: SnapshotBlock[] = [];
    const loose: SnapshotBlock[] = [];
    let insertAt = -1;
    for (const child of children) {
      if (child.blockType === column.key) {
        wrapped.push(child);
        continue;
      }
      if (insertAt < 0) insertAt = wrapped.length;
      loose.push(child);
    }
    wrapped.splice(insertAt, 0, {
      id: `${block.id}:column`,
      blockType: column.key,
      schemaVersion: column.schemaVersion,
      props: {},
      children: Object.freeze(loose),
    });
    return { ...block, children: Object.freeze(wrapped) };
  };

  return normaliseList(blocks);
}
