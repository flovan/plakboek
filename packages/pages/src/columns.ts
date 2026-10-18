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
 *
 * `upgradeSectionColumns` and `upgradeAllSectionColumns` are trusted system
 * operations, not user actions. They take no actor, check no permission and
 * write no audit row: the change moves no content, only adds empty columns
 * and nests existing blocks one level, and is recorded as a revision batch
 * with no author, so the page history shows it for what it is. Whoever calls
 * them has already decided the call is allowed. Nothing that serves a request
 * may call them without authorising the caller first (the editor's page open
 * does, behind `pages:edit`), and no HTTP route may expose them directly.
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
import { isPageLockLive, PAGE_EDIT_LOCK_TTL_SECONDS } from './locks.js';
import { getPageEditLocking } from './settings.js';

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
 * It respects the page's edit lock like every other write to the tree: while
 * project-wide locking is on and someone other than `actorUserId` holds a
 * live lock, the page is left exactly as it is (nothing is rewritten and the
 * version does not move under the holder's open editor), and the result is
 * the same as for a page with nothing to do. Pass the user on whose behalf
 * the upgrade runs, if any, so their own lock does not block it; a run with
 * no acting user (the boot-time upgrade) yields to every live lock.
 *
 * A trusted system operation (see the file header): it checks no permission
 * and writes no audit row, because it has no acting user to authorise or
 * attribute; the caller is responsible for having authorised the call. It
 * never publishes and never purges a cache: what
 * visitors see is the published snapshot, normalised on read
 * (`normaliseSnapshotColumns`); the page simply shows pending changes until
 * it is published again.
 */
export async function upgradeSectionColumns(
  deps: PagesDeps,
  input: {
    readonly pageId: string;
    /** The user the upgrade runs for: a live lock of theirs does not block
     * it. Omit for a run with no acting user. */
    readonly actorUserId?: string;
  },
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
      .select({
        id: pages.id,
        locale: pages.locale,
        version: pages.version,
        lockedBy: pages.lockedBy,
        lockedAt: pages.lockedAt,
      })
      .from(pages)
      .where(eq(pages.id, input.pageId))
      .for('update');
    if (page === undefined) return { upgraded: false, pageVersion: null };
    if (
      isPageLockLive(page.lockedBy, page.lockedAt, now) &&
      page.lockedBy !== input.actorUserId &&
      (await getPageEditLocking(tx))
    ) {
      return { upgraded: false, pageVersion: null };
    }

    // Locked, not just read: the page row lock does not serialise
    // `updateBlockProps`, which takes no page lock, so a property edit
    // committing between this read and the updates below would otherwise
    // leave the revisions recorded here describing props the stored row no
    // longer has. Lock order stays page, then blocks.
    const rows = await tx
      .select()
      .from(pageBlocks)
      .where(
        and(
          eq(pageBlocks.ownerType, 'page'),
          eq(pageBlocks.ownerId, page.id),
          eq(pageBlocks.locale, page.locale),
        ),
      )
      .for('update');

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
 * column kind. Pages held by a live edit lock are left out (see
 * `upgradeSectionColumns`) and picked up by a later run once the lock is gone.
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
  // A page someone is editing is left for later, and kept out of the
  // candidates so a batch of held pages cannot hide the pages behind them.
  // A lock lapses at `locked_at` plus the TTL, as `isPageLockLive` has it.
  const lockedOut = (await getPageEditLocking(deps.db))
    ? sql`AND (
        p.locked_by IS NULL
        OR p.locked_at IS NULL
        OR p.locked_at <= ${new Date(
          (deps.now ?? (() => new Date()))().getTime() -
            PAGE_EDIT_LOCK_TTL_SECONDS * 1000,
        ).toISOString()}::timestamptz
      )`
    : sql``;

  const result: unknown = await deps.db.execute(sql`
    SELECT DISTINCT s.owner_id AS "pageId"
    FROM page_blocks s
    JOIN pages p ON p.id = s.owner_id AND p.locale = s.locale
    WHERE s.owner_type = 'page'
      ${lockedOut}
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
