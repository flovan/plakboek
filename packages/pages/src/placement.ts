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
import { eq, sql } from 'drizzle-orm';
import { getBlockDefinition, type BlockDefinition } from './registry.js';
import { pageBlocks } from './schema.js';
import type { OwnerRef, OwnerType } from './types.js';

/** The sentinel `allowedParents` key naming "the tree's own root" (no
 * parent block, one page owner) -- distinct from any real block key, since
 * `BLOCK_KEY_PATTERN` requires a key to start with a lowercase letter and
 * this sentinel starts with `@`. */
export const ROOT_PARENT_SENTINEL = '@root';

/** Why a placement is refused. The order here is the order `checkPlacement`
 * evaluates the rules in. */
export type PlacementRefusalReason =
  | 'owner-type'
  | 'section-required'
  | 'parent-rejects-child'
  | 'child-rejects-parent'
  | 'column-requires-section'
  | 'section-requires-columns'
  | 'section-nesting'
  | 'block-depth';

/** Everything `checkPlacement` needs, already loaded. `section` is the
 * column parent's own section (null when the parent is not a column);
 * `columnsEnabled` is whether the registry holds a column kind at all. */
export type PlacementCheckInput = {
  readonly ownerType: OwnerType;
  readonly child: BlockDefinition;
  readonly parent: BlockDefinition | null;
  readonly section: BlockDefinition | null;
  readonly parentDepth: number | null;
  readonly parentSectionDepth: number;
  readonly sectionNestingDepth: number;
  readonly blockDepthCeiling: number;
  readonly columnsEnabled: boolean;
};

export type PlacementContext = {
  readonly owner: OwnerRef;
  readonly child: BlockDefinition;
  readonly parent: BlockDefinition | null;
  readonly section: BlockDefinition | null;
  readonly parentDepth: number | null;
  readonly parentSectionDepth: number;
  readonly sectionNestingDepth: number;
  readonly blockDepthCeiling: number;
  readonly columnsEnabled: boolean;
};

export type BlockPlacementReason =
  | 'owner-type'
  | 'parent-rejects-child'
  | 'child-rejects-parent'
  | 'column-requires-section'
  | 'section-requires-columns';

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
          : reason === 'child-rejects-parent'
            ? `block "${childKey}" does not accept parent block "${parentKey}"`
            : reason === 'column-requires-section'
              ? `column block "${childKey}" can only sit directly under a section, not under ${parentKey === null ? 'the page root' : `block "${parentKey}"`}`
              : `section block "${parentKey}" can only hold columns, not block "${childKey}"`;
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
 * The pure placement decision: the refusal reason, or null when the
 * placement is legal. Never throws and touches nothing, so an editor can
 * draw legal drop targets from the same rule every write enforces
 * (`assertPlacementAllowed` throws exactly from this answer). Checked in the
 * order that names the most specific reason first: owner type, the page-
 * children-are-sections rule (D-19), the column rules (D-01, D-03), the
 * parent/child mutual placement declarations (D-08) judged against the
 * column's section when the parent is a column (D-02, the column is
 * transparent), the section nesting cap (D-18; a column is not a section, so
 * it never counts), then the global block depth ceiling. The column rules
 * apply only when the registry holds a column kind (`columnsEnabled`).
 */
export function checkPlacement(
  input: PlacementCheckInput,
): PlacementRefusalReason | null {
  const { child, parent } = input;

  if (!child.placement.ownerTypes.includes(input.ownerType)) {
    return 'owner-type';
  }

  if (
    parent === null &&
    input.ownerType === 'page' &&
    child.kind !== 'section'
  ) {
    return 'section-required';
  }

  if (child.kind === 'column') {
    // A core column is always legal under a section and nowhere else, so its
    // own allowedChildren/allowedParents declarations are not consulted.
    if (parent?.kind !== 'section') return 'column-requires-section';
  } else {
    if (input.columnsEnabled && parent?.kind === 'section') {
      return 'section-requires-columns';
    }

    let effectiveParent: BlockDefinition | null = parent;
    if (parent?.kind === 'column') {
      if (input.section === null) return 'column-requires-section';
      effectiveParent = input.section;
    }

    if (effectiveParent !== null) {
      const allowedChildren = effectiveParent.placement.allowedChildren;
      const parentAccepts =
        allowedChildren === 'any'
          ? true
          : allowedChildren === 'none'
            ? false
            : allowedChildren.includes(child.key);
      if (!parentAccepts) return 'parent-rejects-child';
    }

    const allowedParents = child.placement.allowedParents;
    const parentKeyForCheck =
      effectiveParent === null ? ROOT_PARENT_SENTINEL : effectiveParent.key;
    const childAccepts =
      allowedParents === 'any'
        ? true
        : allowedParents.includes(parentKeyForCheck);
    if (!childAccepts) return 'child-rejects-parent';
  }

  if (
    child.kind === 'section' &&
    input.parentSectionDepth + 1 > input.sectionNestingDepth
  ) {
    return 'section-nesting';
  }

  if ((input.parentDepth ?? -1) + 1 > input.blockDepthCeiling) {
    return 'block-depth';
  }

  return null;
}

/**
 * Refuses a tree shape the renderer could not handle: runs `checkPlacement`
 * and throws the error class for its answer. Throws on the first failure --
 * never collects multiple problems, since a write only ever attempts one
 * placement.
 */
export function assertPlacementAllowed(context: PlacementContext): void {
  const { owner, child, parent } = context;
  const reason = checkPlacement({
    ownerType: owner.ownerType,
    child,
    parent,
    section: context.section,
    parentDepth: context.parentDepth,
    parentSectionDepth: context.parentSectionDepth,
    sectionNestingDepth: context.sectionNestingDepth,
    blockDepthCeiling: context.blockDepthCeiling,
    columnsEnabled: context.columnsEnabled,
  });
  if (reason === null) return;

  switch (reason) {
    case 'owner-type':
      throw new BlockPlacementError(
        'owner-type',
        child.key,
        null,
        owner.ownerType,
      );
    case 'section-required':
      throw new SectionRequiredError(child.key);
    case 'parent-rejects-child': {
      const effectiveParent =
        parent?.kind === 'column' ? context.section : parent;
      throw new BlockPlacementError(
        'parent-rejects-child',
        child.key,
        effectiveParent?.key ?? null,
        null,
      );
    }
    case 'child-rejects-parent': {
      const effectiveParent =
        parent?.kind === 'column' ? context.section : parent;
      throw new BlockPlacementError(
        'child-rejects-parent',
        child.key,
        effectiveParent?.key ?? null,
        null,
      );
    }
    case 'column-requires-section':
      throw new BlockPlacementError(
        'column-requires-section',
        child.key,
        parent?.key ?? null,
        null,
      );
    case 'section-requires-columns':
      throw new BlockPlacementError(
        'section-requires-columns',
        child.key,
        parent?.key ?? null,
        null,
      );
    case 'section-nesting':
      throw new SectionNestingDepthExceededError(
        context.sectionNestingDepth,
        context.parentSectionDepth + 1,
      );
    case 'block-depth':
      throw new BlockDepthExceededError(
        context.blockDepthCeiling,
        (context.parentDepth ?? -1) + 1,
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

export type LoadedParentForPlacement = {
  readonly parentDefinition: BlockDefinition;
  readonly parentDepth: number;
  readonly parentSectionDepth: number;
  /** The column parent's own section; null when the parent is not a column. */
  readonly sectionDefinition: BlockDefinition | null;
};

/**
 * Loads and locks a destination parent block `FOR UPDATE` and everything
 * placement needs to judge a child under it: its depth, its definition, the
 * section depth above it, and -- when it is a column -- its own section's
 * definition (a block under a column is judged against that section). Returns
 * null when the parent row does not exist. Shared by insert, move and both
 * restore replays so every write path builds the same context.
 */
export async function loadParentForPlacement(
  tx: AuditTransaction,
  parentBlockId: string,
): Promise<LoadedParentForPlacement | null> {
  const [parentRow] = await tx
    .select({
      depth: pageBlocks.depth,
      blockType: pageBlocks.blockType,
      parentBlockId: pageBlocks.parentBlockId,
    })
    .from(pageBlocks)
    .where(eq(pageBlocks.id, parentBlockId))
    .for('update');
  if (parentRow === undefined) return null;

  const parentDefinition = getBlockDefinition(parentRow.blockType);
  const parentSectionDepth = await countAncestorSections(tx, parentBlockId);

  let sectionDefinition: BlockDefinition | null = null;
  if (parentDefinition.kind === 'column' && parentRow.parentBlockId !== null) {
    const [sectionRow] = await tx
      .select({ blockType: pageBlocks.blockType })
      .from(pageBlocks)
      .where(eq(pageBlocks.id, parentRow.parentBlockId));
    if (sectionRow !== undefined) {
      try {
        sectionDefinition = getBlockDefinition(sectionRow.blockType);
      } catch {
        sectionDefinition = null;
      }
    }
  }

  return {
    parentDefinition,
    parentDepth: parentRow.depth,
    parentSectionDepth,
    sectionDefinition,
  };
}
