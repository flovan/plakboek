/**
 * Subtree-height-aware placement re-checks and the batched descendant-depth
 * rewrite a structural relocation needs (RESEARCH Pitfall 6, D-18) --
 * extracted to its own dependency-free leaf module so `tree.ts`'s
 * `moveBlock` and `revisions.ts`'s `restoreRevisionBatch` enforce the
 * identical invariant from the SAME implementation, never two that can
 * drift apart (code review CR-02). `tree.ts` already imports from
 * `revisions.ts` (for `recordBlockRevision`/`pruneBlockRevisions`), so a
 * module imported by both must import from neither -- the same
 * dependency-free-leaf shape `warnings.ts` established for the identical
 * class of problem (04-05/04-08's `config.ts <-> section-lint.ts` cycle).
 */
import type { AuditDatabase, AuditTransaction } from '@plakboek/auth';
import { sql } from 'drizzle-orm';
import { getBlockDefinition } from './registry.js';

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. Mirrors
 * `tree.ts`'s/`revisions.ts`'s helper of the same shape. */
function resultRows(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (typeof result === 'object' && result !== null) {
    const rows: unknown = Reflect.get(result, 'rows');
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `@plakboek/pages: expected column "${field}" to be a string`,
    );
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(
      `@plakboek/pages: expected column "${field}" to be a number`,
    );
  }
  return value;
}

export type SubtreeWalkRow = {
  readonly id: string;
  readonly parentBlockId: string | null;
  readonly blockType: string;
  readonly relDepth: number;
};

/** Walks `rootBlockId` and every descendant in ONE recursive CTE query,
 * returning each row's id, its real `parent_block_id` and its depth
 * relative to `rootBlockId` (`0` for the root itself, `1` for its direct
 * children, ...). Shared by `moveBlock`'s circular-move refusal and
 * subtree-height check, and `restoreRevisionBatch`'s `'move'`-kind replay
 * (CR-02) -- never a query per descendant. */
export async function walkSubtree(
  db: AuditDatabase,
  rootBlockId: string,
): Promise<readonly SubtreeWalkRow[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, parent_block_id, block_type, 0 AS rel_depth
      FROM page_blocks
      WHERE id = ${rootBlockId}

      UNION ALL

      SELECT pb.id, pb.parent_block_id, pb.block_type, subtree.rel_depth + 1
      FROM page_blocks pb
      JOIN subtree ON pb.parent_block_id = subtree.id
    )
    SELECT id, parent_block_id AS "parentBlockId", block_type AS "blockType",
      rel_depth AS "relDepth"
    FROM subtree
  `);
  return resultRows(result).map((row) => ({
    id: asString(row.id, 'id'),
    parentBlockId: asNullableString(row.parentBlockId),
    blockType: asString(row.blockType, 'blockType'),
    relDepth: asNumber(row.relDepth, 'relDepth'),
  }));
}

export type SubtreeShape = {
  readonly height: number;
  readonly sectionHeight: number;
};

/**
 * Computes a subtree's own height (its greatest relative depth) and its
 * section-only height (the deepest nesting of `kind: 'section'` blocks
 * WITHIN the subtree, `rootId` included) from `walkSubtree`'s rows -- the
 * addendum that makes a relocation (a move, or a move replayed by a
 * restore) stricter than a plain insert: an insert only ever checks a
 * single node's own resulting depth/section-depth against the destination;
 * a relocation must also account for whatever the relocated node is
 * carrying with it (RESEARCH Pitfall 6, D-08, D-18). When the subtree has
 * no descendants, `height` is `0` and `sectionHeight` is the root's own
 * section contribution (`0` or `1`) -- the same number a single-node check
 * would already have produced, so this never disagrees with
 * `assertPlacementAllowed`'s own arithmetic in the childless case, only
 * extends it when there are live descendants.
 */
export function computeSubtreeShape(
  rows: readonly SubtreeWalkRow[],
  rootId: string,
): SubtreeShape {
  let height = 0;
  let sectionHeight = 0;
  const sectionDepthById = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => a.relDepth - b.relDepth)) {
    let isSectionBlock: boolean;
    try {
      isSectionBlock = getBlockDefinition(row.blockType).kind === 'section';
    } catch {
      isSectionBlock = false;
    }
    const parentSectionDepthWithinSubtree =
      row.id === rootId
        ? 0
        : (sectionDepthById.get(row.parentBlockId ?? '') ?? 0);
    const sectionDepth =
      parentSectionDepthWithinSubtree + (isSectionBlock ? 1 : 0);
    sectionDepthById.set(row.id, sectionDepth);
    height = Math.max(height, row.relDepth);
    sectionHeight = Math.max(sectionHeight, sectionDepth);
  }
  return { height, sectionHeight };
}

/**
 * Recomputes every descendant's `depth` in one batched `UPDATE ... FROM
 * (VALUES ...)` statement, keyed on each descendant's id and its depth
 * relative to the relocated block's own NEW depth -- never a query per
 * row. `descendantRows` must exclude the relocated block's own row (its
 * caller writes that row's `depth` directly, in the same statement that
 * relocates it). A no-op when `descendantRows` is empty. Shared by
 * `moveBlock` and `restoreRevisionBatch`'s `'move'`-kind replay (CR-02).
 */
export async function rewriteDescendantDepths(
  tx: AuditTransaction,
  newRootDepth: number,
  descendantRows: readonly SubtreeWalkRow[],
): Promise<void> {
  if (descendantRows.length === 0) return;
  const depthValuesClause = sql.join(
    descendantRows.map(
      (row) => sql`(${row.id}::uuid, ${newRootDepth + row.relDepth}::integer)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    UPDATE page_blocks SET depth = v.new_depth
    FROM (VALUES ${depthValuesClause}) AS v(id, new_depth)
    WHERE page_blocks.id = v.id
  `);
}
