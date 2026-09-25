/**
 * Write-time placement enforcement (BLOCK-05, D-08, D-18, D-19): the tree
 * shape a renderer can handle -- every block sits under a section ancestor,
 * a parent only ever holds a child type it declared, and two independent
 * depth caps bound both editorial section nesting and raw recursion -- is
 * guaranteed by the engine on every write, not by convention. `tree.ts`
 * calls `assertPlacementAllowed` inside `insertBlock`'s own transaction,
 * after the page and parent rows are loaded and locked but before any row
 * is written, so a refusal here always rolls the transaction back with
 * nothing persisted (mirrors `@plakboek/content`'s `locks.ts`
 * `assertRowsWritable`: a pure guard function taking already-loaded rows,
 * callable from inside an open transaction and unit-testable without a
 * database).
 */
import type { AuditTransaction } from '@plakboek/auth';
import { sql } from 'drizzle-orm';
import { getBlockDefinition, type BlockDefinition } from './registry.js';
import type { OwnerRef } from './types.js';

/** The sentinel `allowedParents` key naming "the tree's own root" (no
 * parent block, one page owner) -- distinct from any real block key, since
 * `BLOCK_KEY_PATTERN` requires a key to start with a lowercase letter and
 * this sentinel starts with `@`. */
export const ROOT_PARENT_SENTINEL = '@root';

export type PlacementContext = {
  readonly owner: OwnerRef;
  readonly child: BlockDefinition;
  readonly parent: BlockDefinition | null;
  readonly parentDepth: number | null;
  readonly parentSectionDepth: number;
  readonly sectionNestingDepth: number;
  readonly blockDepthCeiling: number;
};

export type BlockPlacementReason =
  | 'owner-type'
  | 'parent-rejects-child'
  | 'child-rejects-parent';

/** Thrown by `assertPlacementAllowed` for every placement refusal except
 * the section-specific ones (`SectionRequiredError`,
 * `SectionNestingDepthExceededError`) and the depth ceiling
 * (`BlockDepthExceededError`), which carry their own dedicated types so a
 * caller can tell the three refusal families apart without parsing a
 * message. */
export class BlockPlacementError extends Error {
  readonly reason: BlockPlacementReason;
  readonly childKey: string;
  readonly parentKey: string | null;
  readonly ownerType: string | null;

  constructor(
    reason: BlockPlacementReason,
    childKey: string,
    parentKey: string | null,
    ownerType: string | null,
  ) {
    const detail =
      reason === 'owner-type'
        ? `block "${childKey}" is not allowed under owner type "${ownerType}"`
        : reason === 'parent-rejects-child'
          ? `block "${parentKey}" does not accept child block "${childKey}"`
          : `block "${childKey}" does not accept parent block "${parentKey}"`;
    super(`@plakboek/pages: ${detail}`);
    this.name = 'BlockPlacementError';
    this.reason = reason;
    this.childKey = childKey;
    this.parentKey = parentKey;
    this.ownerType = ownerType;
  }
}

/** Thrown when a non-section block is inserted with no parent directly
 * under a page owner (D-19): a page's direct children are always sections,
 * and the engine refuses rather than inventing a default section around a
 * bare block -- that would be a structural write the caller did not ask
 * for. Phase 8 creates the wrapping section explicitly instead. */
export class SectionRequiredError extends Error {
  readonly blockType: string;

  constructor(blockType: string) {
    super(
      `@plakboek/pages: a page's direct children must be sections; block "${blockType}" cannot sit directly under a page (Phase 8 wraps a bare block in a default section instead of the engine inventing one)`,
    );
    this.name = 'SectionRequiredError';
    this.blockType = blockType;
  }
}

/** Thrown when inserting a section would exceed `sectionNestingDepth`
 * (D-18), counted in sections only -- a section nested inside a section
 * that itself sits inside a non-section block still counts as section
 * depth 2, not 3. */
export class SectionNestingDepthExceededError extends Error {
  readonly cap: number;
  readonly attempted: number;

  constructor(cap: number, attempted: number) {
    super(
      `@plakboek/pages: section nesting depth ${attempted} exceeds the configured cap of ${cap}`,
    );
    this.name = 'SectionNestingDepthExceededError';
    this.cap = cap;
    this.attempted = attempted;
  }
}

/** Thrown when inserting any block -- section or not -- would exceed
 * `blockDepthCeiling`: a separate, coarser runaway-recursion guard from
 * `SectionNestingDepthExceededError`, bounding the recursive-CTE read and
 * the snapshot builder regardless of what a block's own `allowedChildren`
 * declaration permits (RESEARCH Pitfall 6). */
export class BlockDepthExceededError extends Error {
  readonly ceiling: number;
  readonly attempted: number;

  constructor(ceiling: number, attempted: number) {
    super(
      `@plakboek/pages: block depth ${attempted} exceeds the configured ceiling of ${ceiling}`,
    );
    this.name = 'BlockDepthExceededError';
    this.ceiling = ceiling;
    this.attempted = attempted;
  }
}

/**
 * Refuses a tree shape the renderer could not handle, in the order that
 * names the most specific reason first: owner type, then the page-children-
 * are-sections rule (D-19), then the parent/child mutual placement
 * declarations (D-08), then the section nesting cap (D-18), then the global
 * block depth ceiling. Throws on the first failure -- never collects
 * multiple problems, since a write only ever attempts one placement.
 */
export function assertPlacementAllowed(context: PlacementContext): void {
  const { owner, child, parent } = context;

  if (!child.placement.ownerTypes.includes(owner.ownerType)) {
    throw new BlockPlacementError(
      'owner-type',
      child.key,
      null,
      owner.ownerType,
    );
  }

  if (
    parent === null &&
    owner.ownerType === 'page' &&
    child.kind !== 'section'
  ) {
    throw new SectionRequiredError(child.key);
  }

  if (parent !== null) {
    const allowedChildren = parent.placement.allowedChildren;
    const parentAccepts =
      allowedChildren === 'any'
        ? true
        : allowedChildren === 'none'
          ? false
          : allowedChildren.includes(child.key);
    if (!parentAccepts) {
      throw new BlockPlacementError(
        'parent-rejects-child',
        child.key,
        parent.key,
        null,
      );
    }
  }

  const allowedParents = child.placement.allowedParents;
  const parentKeyForCheck = parent === null ? ROOT_PARENT_SENTINEL : parent.key;
  const childAccepts =
    allowedParents === 'any'
      ? true
      : allowedParents.includes(parentKeyForCheck);
  if (!childAccepts) {
    throw new BlockPlacementError(
      'child-rejects-parent',
      child.key,
      parent === null ? null : parent.key,
      null,
    );
  }

  if (child.kind === 'section') {
    const resultingSectionDepth = context.parentSectionDepth + 1;
    if (resultingSectionDepth > context.sectionNestingDepth) {
      throw new SectionNestingDepthExceededError(
        context.sectionNestingDepth,
        resultingSectionDepth,
      );
    }
  }

  const resultingBlockDepth = (context.parentDepth ?? -1) + 1;
  if (resultingBlockDepth > context.blockDepthCeiling) {
    throw new BlockDepthExceededError(
      context.blockDepthCeiling,
      resultingBlockDepth,
    );
  }
}

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. Mirrors
 * `tree.ts`'s/`compatibility.ts`'s helper of the same shape. */
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

/**
 * Walks from `parentBlockId` up through `parent_block_id` to the root in
 * ONE recursive CTE query, returning the number of ancestors (inclusive
 * of `parentBlockId` itself) whose `block_type` resolves to a registry
 * entry with `kind: 'section'`. `kind` is resolved in application code from
 * the registry after the read -- never stored on the row, so the registry
 * stays the single source of truth for what a block type is (an ancestor
 * whose `block_type` is no longer registered is simply not counted, the
 * same "degrade, don't throw" posture `readBlockTree`'s upcast-on-read
 * takes for an unknown type). Every dynamic value goes through the tagged
 * `sql` template -- no string concatenation.
 */
export async function countAncestorSections(
  tx: AuditTransaction,
  parentBlockId: string,
): Promise<number> {
  const result: unknown = await tx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_block_id, block_type
      FROM page_blocks
      WHERE id = ${parentBlockId}

      UNION ALL

      SELECT pb.id, pb.parent_block_id, pb.block_type
      FROM page_blocks pb
      JOIN ancestors a ON pb.id = a.parent_block_id
    )
    SELECT block_type AS "blockType" FROM ancestors
  `);

  let count = 0;
  for (const row of resultRows(result)) {
    const blockType = asString(row.blockType, 'blockType');
    let definition: BlockDefinition | undefined;
    try {
      definition = getBlockDefinition(blockType);
    } catch {
      definition = undefined;
    }
    if (definition?.kind === 'section') count += 1;
  }
  return count;
}
