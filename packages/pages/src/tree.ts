/**
 * The adjacency-list tree read/write layer -- the newest engineering
 * surface this phase adds (D-38, BLOCK-12). `readBlockTree` issues one
 * recursive CTE query through `tx.execute(sql\`...\`)` (04-RESEARCH.md
 * Pattern 2; Drizzle has no query-builder support for recursive CTEs) and
 * assembles the flat, `sort_path`-ordered rows into a nested `BlockNode[]`
 * in one pass, running each row's `props` through `upcastOnRead` -- never
 * writing anything back (BLOCK-12, D-11). `insertBlock`/`updateBlockProps`
 * follow the same `FOR UPDATE` + version-check + bump shape
 * `@plakboek/content`'s `save.ts` established, split per D-38's dual-scope
 * rule: a property edit checks/bumps only the touched block's own
 * `version`; an insert additionally checks the owning page's `version`
 * (a structural change) and bumps both.
 *
 * Every function here is keyed on the owner tuple (`OwnerRef`), never on a
 * bare `pageId` -- see the plan's `<assumption_delta_decision>`: a page is
 * one variant of owner, not the identity of the tree.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { getRevisionCap } from '@plakboek/content';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { PagesDeps, PagesHooks } from './config.js';
import { assertPageWritable } from './locks.js';
import {
  needsRebalance,
  nextSortOrder,
  rebalancedOrders,
  sortOrderBetween,
} from './ordering.js';
import {
  getPage,
  loadPageForUpdate,
  PageNotFoundError,
  StalePageVersionError,
} from './pages.js';
import {
  assertPlacementAllowed,
  BlockDepthExceededError,
  countAncestorSections,
  SectionNestingDepthExceededError,
} from './placement.js';
import {
  getBlockDefinition,
  validateBlockProps,
  type BlockDefinition,
} from './registry.js';
import {
  newRevisionBatchId,
  pruneBlockRevisions,
  recordBlockRevision,
} from './revisions.js';
import { blockRevisions, pageBlocks, pages } from './schema.js';
import { getPageEditLocking } from './settings.js';
import {
  computeSubtreeShape,
  rewriteDescendantDepths,
  walkSubtree,
} from './subtree.js';
import {
  OWNER_TYPES,
  type BlockNode,
  type BlockRecord,
  type OwnerRef,
  type OwnerType,
} from './types.js';
import {
  createUpcastSession,
  reportDegradedBlock,
  type UpcastSession,
} from './versioning.js';

// `StalePageVersionError` is now defined in `pages.ts` (D-38: `movePage`,
// `renamePage` and `createPage`'s parent-load path all need it too, and
// `pages.ts` cannot import it back from here without a circular
// pages.ts <-> tree.ts dependency -- STATE.md's Phase 4 quick-task already
// hit and fixed one such cycle in this package). Re-exported here so
// `publish.ts`'s and `index.ts`'s existing `from './tree.js'` imports keep
// resolving unchanged.
export { StalePageVersionError } from './pages.js';

/** Thrown when a block write's `baseVersion` no longer matches the row's
 * current `version` -- a property edit names only the touched block's own
 * version (D-38). */
export class StaleBlockVersionError extends Error {
  readonly blockId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(blockId: string, expectedVersion: number, actualVersion: number) {
    super(
      `@plakboek/pages: block "${blockId}" was modified by someone else since it was loaded (expected version ${expectedVersion}, now ${actualVersion})`,
    );
    this.name = 'StaleBlockVersionError';
    this.blockId = blockId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Thrown when a block write names a `blockId`/`parentBlockId` that no
 * longer exists. */
export class BlockNotFoundError extends Error {
  readonly blockId: string;

  constructor(blockId: string) {
    super(`@plakboek/pages: no block found for id "${blockId}"`);
    this.name = 'BlockNotFoundError';
    this.blockId = blockId;
  }
}

function isOwnerType(value: string): value is OwnerType {
  return OWNER_TYPES.some((type) => type === value);
}

function asOwnerType(value: string): OwnerType {
  if (isOwnerType(value)) return value;
  throw new TypeError(
    `@plakboek/pages: unexpected owner_type "${value}" stored for a block`,
  );
}

function toBlockRecordFromRow(
  row: typeof pageBlocks.$inferSelect,
): BlockRecord {
  return {
    id: row.id,
    ownerType: asOwnerType(row.ownerType),
    ownerId: row.ownerId,
    locale: row.locale,
    parentBlockId: row.parentBlockId,
    blockType: row.blockType,
    props: row.props,
    schemaVersion: row.schemaVersion,
    depth: row.depth,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. Mirrors
 * `@plakboek/content`'s `settings.ts` helper of the same shape. */
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

/** A raw `execute()` result reports a `timestamptz` column as a `Date`
 * instance on some drivers and as an ISO string on others -- unlike
 * Drizzle's query builder (`.select()`), which always maps it through the
 * column's own driver-value parser. Both are accepted here and normalised
 * to a `Date`. */
function asDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new TypeError(
    `@plakboek/pages: expected column "${field}" to be a date`,
  );
}

type TreeRow = {
  readonly id: string;
  readonly parentBlockId: string | null;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly locale: string;
  readonly blockType: string;
  readonly props: unknown;
  readonly schemaVersion: number;
  readonly depth: number;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

function toTreeRow(row: Record<string, unknown>): TreeRow {
  return {
    id: asString(row.id, 'id'),
    parentBlockId: asNullableString(row.parentBlockId),
    ownerType: asString(row.ownerType, 'ownerType'),
    ownerId: asString(row.ownerId, 'ownerId'),
    locale: asString(row.locale, 'locale'),
    blockType: asString(row.blockType, 'blockType'),
    props: row.props,
    schemaVersion: asNumber(row.schemaVersion, 'schemaVersion'),
    depth: asNumber(row.depth, 'depth'),
    sortOrder: asNumber(row.sortOrder, 'sortOrder'),
    version: asNumber(row.version, 'version'),
    createdAt: asDate(row.createdAt, 'createdAt'),
    updatedAt: asDate(row.updatedAt, 'updatedAt'),
  };
}

type RawNode = {
  readonly row: TreeRow;
  readonly children: RawNode[];
};

/** Assembles the flat, `sort_path`-ordered rows into a nested `RawNode[]`
 * of roots in one pass -- a node's `sort_path` prefix is its ancestors',
 * so a parent row is always seen before its children's rows. */
function buildRawTree(rows: readonly TreeRow[]): RawNode[] {
  const byId = new Map<string, RawNode>();
  const childrenByParent = new Map<string | null, RawNode[]>();

  for (const row of rows) {
    const node: RawNode = { row, children: [] };
    byId.set(row.id, node);
    const siblings = childrenByParent.get(row.parentBlockId) ?? [];
    siblings.push(node);
    childrenByParent.set(row.parentBlockId, siblings);
  }
  for (const node of byId.values()) {
    node.children.push(...(childrenByParent.get(node.row.id) ?? []));
  }
  return childrenByParent.get(null) ?? [];
}

function toBlockNode(
  raw: RawNode,
  session: UpcastSession,
  hooks: PagesHooks | undefined,
): BlockNode {
  const record: BlockRecord = {
    id: raw.row.id,
    ownerType: asOwnerType(raw.row.ownerType),
    ownerId: raw.row.ownerId,
    locale: raw.row.locale,
    parentBlockId: raw.row.parentBlockId,
    blockType: raw.row.blockType,
    props: raw.row.props,
    schemaVersion: raw.row.schemaVersion,
    depth: raw.row.depth,
    sortOrder: raw.row.sortOrder,
    version: raw.row.version,
    createdAt: raw.row.createdAt,
    updatedAt: raw.row.updatedAt,
  };

  // Read separately from `session.upcast` below purely to report the
  // registry's current `schemaVersion` on a degraded event -- an
  // unregistered block type (caught inside `session.upcast` itself) leaves
  // this `null`, matching `DegradedBlockEvent.currentVersion`.
  let currentVersion: number | null;
  try {
    currentVersion = getBlockDefinition(raw.row.blockType).schemaVersion;
  } catch {
    currentVersion = null;
  }

  const outcome = session.upcast(
    raw.row.blockType,
    raw.row.schemaVersion,
    raw.row.props,
  );

  if (outcome.degraded) {
    reportDegradedBlock(hooks, {
      blockId: raw.row.id,
      blockType: raw.row.blockType,
      storedVersion: raw.row.schemaVersion,
      currentVersion,
      reason: outcome.reason,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      occurredAt: new Date(),
    });
  }

  const children = Object.freeze(
    raw.children.map((child) => toBlockNode(child, session, hooks)),
  );

  return outcome.degraded
    ? {
        ...record,
        props: outcome.props,
        degraded: true,
        degradedReason: outcome.reason,
        children,
      }
    : { ...record, props: outcome.props, degraded: false, children };
}

/**
 * Reads one owner's full block tree in one recursive CTE query
 * (04-RESEARCH.md Pattern 2), ordered depth-first by `sort_path`. Every
 * dynamic value (`owner.ownerType`, `owner.ownerId`, `owner.locale`) is
 * interpolated through Drizzle's tagged `sql` template -- no string
 * concatenation anywhere. One `createUpcastSession` is built for this
 * whole read and applied per row, resolving the block's registry entry by
 * `block_type`; an unregistered type yields a degraded node
 * (`unknown-block-type`) rather than throwing. Every degraded row is
 * reported once through `reportDegradedBlock` (`hooks?.onDegradedBlock`,
 * or the console-warning default when `hooks` is omitted). Never writes:
 * the stored `props` bytes are untouched by a read (BLOCK-12, D-11).
 * Accepts a plain database handle or an open transaction (both expose the
 * same `execute` surface), so `publishPage` can read the same tree it is
 * about to snapshot from inside its own transaction.
 */
export async function readBlockTree(
  db: AuditDatabase,
  owner: OwnerRef,
  hooks?: PagesHooks,
): Promise<readonly BlockNode[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT
        id, parent_block_id, owner_type, owner_id, locale, block_type,
        props, schema_version, depth, sort_order, version, created_at,
        updated_at, ARRAY[sort_order] AS sort_path
      FROM page_blocks
      WHERE owner_type = ${owner.ownerType}
        AND owner_id = ${owner.ownerId}
        AND locale = ${owner.locale}
        AND parent_block_id IS NULL

      UNION ALL

      SELECT
        pb.id, pb.parent_block_id, pb.owner_type, pb.owner_id, pb.locale,
        pb.block_type, pb.props, pb.schema_version, pb.depth, pb.sort_order,
        pb.version, pb.created_at, pb.updated_at,
        tree.sort_path || pb.sort_order
      FROM page_blocks pb
      JOIN tree ON pb.parent_block_id = tree.id
    )
    SELECT
      id, parent_block_id AS "parentBlockId", owner_type AS "ownerType",
      owner_id AS "ownerId", locale, block_type AS "blockType", props,
      schema_version AS "schemaVersion", depth, sort_order AS "sortOrder",
      version, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM tree
    ORDER BY sort_path
  `);
  const rows = resultRows(result).map(toTreeRow);
  const rawRoots = buildRawTree(rows);
  const session = createUpcastSession();
  return Object.freeze(rawRoots.map((raw) => toBlockNode(raw, session, hooks)));
}

export type InsertBlockInput = {
  readonly owner: OwnerRef;
  readonly blockType: string;
  readonly parentBlockId: string | null;
  readonly sortOrder?: number;
  readonly props?: unknown;
  readonly basePageVersion: number;
};

/**
 * Inserts a block (a structural change, D-38). Through `deps.recorder.run`
 * (`pages:edit` / `block.insert`): resolves `input.blockType`'s definition
 * first, before any row is loaded, so an unregistered type refuses
 * immediately (`UnknownBlockTypeError`); loads and locks the owning page
 * `FOR UPDATE`, throwing `StalePageVersionError` when `page.version !==
 * input.basePageVersion`; loads and locks the parent block `FOR UPDATE`
 * when given and derives `depth` as `parent.depth + 1` (`0` at the root);
 * calls `assertPlacementAllowed` (placement.ts, BLOCK-05, D-08, D-18, D-19)
 * -- the section rule, the parent/child placement declarations and both
 * depth caps -- before any write; validates `props` through
 * `validateBlockProps`; computes `sortOrder` as `max(sort_order) + 1000`
 * among siblings when not supplied; inserts with `schema_version` set to
 * the registry's current `schemaVersion` for that block type -- never a
 * default, never null; records a `'create'` block revision; bumps the
 * owning page's `version`.
 */
export async function insertBlock(
  deps: PagesDeps,
  actor: AuditActor,
  input: InsertBlockInput,
): Promise<BlockRecord> {
  const now = deps.now ?? (() => new Date());
  // Read once, before the transaction opens, so the prune call below runs
  // with a value the transaction itself did not have to fetch (04-08).
  const revisionCap = await getRevisionCap(deps.db);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'block.insert',
      entityType: 'page_block',
    },
    async (tx) => {
      const definition = getBlockDefinition(input.blockType);

      const page = await loadPageForUpdate(tx, input.owner.ownerId);
      if (page.version !== input.basePageVersion) {
        throw new StalePageVersionError(
          page.id,
          input.basePageVersion,
          page.version,
        );
      }
      assertPageWritable(
        [page],
        await getPageEditLocking(tx),
        actor.userId,
        now(),
      );

      let parentDefinition: BlockDefinition | null = null;
      let parentDepth: number | null = null;
      let parentSectionDepth = 0;
      if (input.parentBlockId !== null) {
        const [parentRow] = await tx
          .select({ depth: pageBlocks.depth, blockType: pageBlocks.blockType })
          .from(pageBlocks)
          .where(eq(pageBlocks.id, input.parentBlockId))
          .for('update');
        if (parentRow === undefined) {
          throw new BlockNotFoundError(input.parentBlockId);
        }
        parentDepth = parentRow.depth;
        parentDefinition = getBlockDefinition(parentRow.blockType);
        parentSectionDepth = await countAncestorSections(
          tx,
          input.parentBlockId,
        );
      }
      const depth = (parentDepth ?? -1) + 1;

      assertPlacementAllowed({
        owner: input.owner,
        child: definition,
        parent: parentDefinition,
        parentDepth,
        parentSectionDepth,
        sectionNestingDepth: deps.config.sectionNestingDepth,
        blockDepthCeiling: deps.config.blockDepthCeiling,
      });

      const validatedProps = validateBlockProps(definition, input.props ?? {});

      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const siblingCondition =
          input.parentBlockId === null
            ? and(
                eq(pageBlocks.ownerType, input.owner.ownerType),
                eq(pageBlocks.ownerId, input.owner.ownerId),
                eq(pageBlocks.locale, input.owner.locale),
                isNull(pageBlocks.parentBlockId),
              )
            : eq(pageBlocks.parentBlockId, input.parentBlockId);
        const [siblingMax] = await tx
          .select({ max: sql<number | null>`max(${pageBlocks.sortOrder})` })
          .from(pageBlocks)
          .where(siblingCondition);
        sortOrder = nextSortOrder(siblingMax?.max ?? null);
      }

      const createdAt = now();
      const [row] = await tx
        .insert(pageBlocks)
        .values({
          ownerType: input.owner.ownerType,
          ownerId: input.owner.ownerId,
          locale: input.owner.locale,
          parentBlockId: input.parentBlockId,
          blockType: input.blockType,
          props: validatedProps,
          schemaVersion: definition.schemaVersion,
          depth,
          sortOrder,
          version: 1,
          createdBy: actor.userId,
          updatedBy: actor.userId,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      if (row === undefined) {
        throw new Error('@plakboek/pages: block insert returned no row');
      }
      const record = toBlockRecordFromRow(row);

      await recordBlockRevision(tx, {
        blockId: record.id,
        owner: input.owner,
        revisionBatchId: newRevisionBatchId(),
        changeType: 'create',
        kind: 'save',
        blockType: record.blockType,
        parentBlockId: record.parentBlockId,
        sortOrder: record.sortOrder,
        depth: record.depth,
        props: record.props,
        schemaVersion: record.schemaVersion,
        authorId: actor.userId,
        createdAt,
      });

      await tx
        .update(pages)
        .set({ version: sql`${pages.version} + 1` })
        .where(eq(pages.id, page.id));

      await pruneBlockRevisions(tx, {
        pageId: page.id,
        locale: input.owner.locale,
        cap: revisionCap,
      });

      return { result: record, after: record };
    },
  );
}

export type UpdateBlockPropsInput = {
  readonly blockId: string;
  readonly baseVersion: number;
  readonly props: unknown;
};

/**
 * Edits a block's properties (a property-only change, D-38 -- does *not*
 * touch the owning page's `version`). Through `deps.recorder.run`
 * (`pages:edit` / `block.update`): loads and locks the block `FOR UPDATE`,
 * throwing `StaleBlockVersionError` when the version differs; validates
 * `props` through `validateBlockProps`; `UPDATE ... SET props, version =
 * version + 1, updated_at, updated_by WHERE id = ? AND version = ?` (zero
 * rows returned also throws `StaleBlockVersionError`, the same
 * belt-and-braces double-check `@plakboek/content`'s `save.ts` uses);
 * records an `'update'` block revision.
 */
export async function updateBlockProps(
  deps: PagesDeps,
  actor: AuditActor,
  input: UpdateBlockPropsInput,
): Promise<BlockRecord> {
  const now = deps.now ?? (() => new Date());
  const revisionCap = await getRevisionCap(deps.db);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'block.update',
      entityType: 'page_block',
      entityId: input.blockId,
    },
    async (tx) => {
      const [current] = await tx
        .select()
        .from(pageBlocks)
        .where(eq(pageBlocks.id, input.blockId))
        .for('update');
      if (current === undefined) {
        throw new BlockNotFoundError(input.blockId);
      }
      if (current.version !== input.baseVersion) {
        throw new StaleBlockVersionError(
          input.blockId,
          input.baseVersion,
          current.version,
        );
      }

      // A property edit takes no `basePageVersion` (D-38) -- it never
      // checks or bumps the owning page's version -- but it is still an
      // edit to the page's content, so it still honours the page lock. The
      // owning page is loaded unlocked (no `FOR UPDATE`) purely for the
      // guard: taking an exclusive lock on the page row here, after the
      // block row above is already locked, would reverse this package's
      // established page-then-block lock ordering (`moveBlock`/
      // `deleteBlock` lock the page first) and risk an ABBA deadlock
      // against them.
      const page = await getPage(tx, current.ownerId);
      if (page === null) {
        throw new PageNotFoundError(current.ownerId);
      }
      assertPageWritable(
        [page],
        await getPageEditLocking(tx),
        actor.userId,
        now(),
      );

      const definition = getBlockDefinition(current.blockType);
      const validatedProps = validateBlockProps(definition, input.props);

      const updatedAt = now();
      const [row] = await tx
        .update(pageBlocks)
        .set({
          props: validatedProps,
          version: sql`${pageBlocks.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(
          and(
            eq(pageBlocks.id, input.blockId),
            eq(pageBlocks.version, input.baseVersion),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new StaleBlockVersionError(
          input.blockId,
          input.baseVersion,
          current.version,
        );
      }
      const record = toBlockRecordFromRow(row);

      await recordBlockRevision(tx, {
        blockId: record.id,
        owner: {
          ownerType: record.ownerType,
          ownerId: record.ownerId,
          locale: record.locale,
        },
        revisionBatchId: newRevisionBatchId(),
        changeType: 'update',
        kind: 'save',
        blockType: record.blockType,
        parentBlockId: record.parentBlockId,
        sortOrder: record.sortOrder,
        depth: record.depth,
        props: record.props,
        schemaVersion: record.schemaVersion,
        authorId: actor.userId,
        createdAt: updatedAt,
      });

      await pruneBlockRevisions(tx, {
        pageId: record.ownerId,
        locale: record.locale,
        cap: revisionCap,
      });

      return { result: record, after: record };
    },
  );
}

/** Thrown by `moveBlock` when the destination parent is the moved block
 * itself or one of its own descendants -- refused before anything is
 * written. Mirrors `pages.ts`'s `CircularPageMoveError` for the same shape
 * of refusal one level down the tree. */
export class CircularMoveError extends Error {
  readonly blockId: string;
  readonly destinationParentId: string;

  constructor(blockId: string, destinationParentId: string) {
    super(
      `@plakboek/pages: cannot move block "${blockId}" under its own descendant "${destinationParentId}"`,
    );
    this.name = 'CircularMoveError';
    this.blockId = blockId;
    this.destinationParentId = destinationParentId;
  }
}

/** Thrown by `moveBlock` when `beforeSiblingId`/`afterSiblingId` names a
 * block that does not actually belong to the destination parent -- e.g. a
 * caller-supplied id left over from an unrelated parent's sibling list.
 * Without this check the id would still resolve (`resolveSiblingSortOrder`
 * loads purely by id), and the moved block's `sort_order` would be computed
 * relative to a block outside its real sibling list (code review WR-02). */
export class InvalidSiblingReferenceError extends Error {
  readonly siblingId: string;
  readonly expectedParentBlockId: string | null;
  readonly actualParentBlockId: string | null;

  constructor(
    siblingId: string,
    expectedParentBlockId: string | null,
    actualParentBlockId: string | null,
  ) {
    super(
      `@plakboek/pages: sibling "${siblingId}" does not belong to destination parent ${
        expectedParentBlockId === null
          ? '"<root>"'
          : `"${expectedParentBlockId}"`
      } (its actual parent is ${
        actualParentBlockId === null ? '"<root>"' : `"${actualParentBlockId}"`
      })`,
    );
    this.name = 'InvalidSiblingReferenceError';
    this.siblingId = siblingId;
    this.expectedParentBlockId = expectedParentBlockId;
    this.actualParentBlockId = actualParentBlockId;
  }
}

/** Loads a block's `parentBlockId`/`sortOrder`/`depth` for `moveBlock`'s
 * pre-transaction audit `before` snapshot (mirrors `pages.ts`'s
 * `movePage`/`renamePage`, which pre-fetch the same way before opening
 * `deps.recorder.run`). `null` when the block no longer exists -- the
 * transaction's own `FOR UPDATE` load below throws the real
 * `BlockNotFoundError`; this is audit-trail context only. */
async function loadBlockSnapshot(
  db: AuditDatabase,
  blockId: string,
): Promise<{
  readonly parentBlockId: string | null;
  readonly sortOrder: number;
  readonly depth: number;
} | null> {
  const [row] = await db
    .select({
      parentBlockId: pageBlocks.parentBlockId,
      sortOrder: pageBlocks.sortOrder,
      depth: pageBlocks.depth,
    })
    .from(pageBlocks)
    .where(eq(pageBlocks.id, blockId))
    .limit(1);
  return row ?? null;
}

/** Loads the `sort_order` of an optional named sibling, `FOR UPDATE`-locked
 * from the destination sibling list -- `moveBlock`'s `beforeSiblingId`/
 * `afterSiblingId` inputs resolve through this. `null` when the input
 * itself is `null`/`undefined` (an end-of-list placement); throws
 * `BlockNotFoundError` when a named sibling id no longer exists, and
 * `InvalidSiblingReferenceError` when it exists but its own
 * `parent_block_id` does not match `expectedParentBlockId` -- otherwise a
 * caller-supplied id belonging to an unrelated parent would still be
 * accepted, and the moved block's `sort_order` computed relative to it
 * (code review WR-02). */
async function resolveSiblingSortOrder(
  tx: AuditTransaction,
  siblingId: string | null | undefined,
  expectedParentBlockId: string | null,
): Promise<number | null> {
  if (siblingId === null || siblingId === undefined) return null;
  const [row] = await tx
    .select({
      sortOrder: pageBlocks.sortOrder,
      parentBlockId: pageBlocks.parentBlockId,
    })
    .from(pageBlocks)
    .where(eq(pageBlocks.id, siblingId))
    .for('update');
  if (row === undefined) {
    throw new BlockNotFoundError(siblingId);
  }
  if (row.parentBlockId !== expectedParentBlockId) {
    throw new InvalidSiblingReferenceError(
      siblingId,
      expectedParentBlockId,
      row.parentBlockId,
    );
  }
  return row.sortOrder;
}

export type MoveBlockInput = {
  readonly blockId: string;
  readonly baseVersion: number;
  readonly pageId: string;
  readonly basePageVersion: number;
  readonly newParentBlockId: string | null;
  readonly beforeSiblingId?: string | null;
  readonly afterSiblingId?: string | null;
};

/**
 * Moves a block and its whole subtree to a new parent and a new position
 * among its siblings, in one transaction (a structural change, D-38). Every
 * descendant's stored `depth` is recomputed in the same transaction
 * (RESEARCH Pitfall 6). Through `deps.recorder.run` (`pages:edit` /
 * `block.move`), in order: loads and locks the owning page `FOR UPDATE`,
 * throwing `StalePageVersionError` on a base-version mismatch (a move is a
 * structural change, so it takes the page version as well as the block's
 * own); loads and locks the moved block `FOR UPDATE`, throwing
 * `StaleBlockVersionError` on a mismatch; loads and locks the destination
 * parent `FOR UPDATE` when non-null; walks the moved block's descendants in
 * one recursive CTE query, collecting the subtree's own height and its
 * section-only height (counting only rows whose registry `kind` is
 * `'section'`); refuses `CircularMoveError` when the destination is the
 * moved block itself or one of its own descendants; re-runs
 * `assertPlacementAllowed` against the destination exactly as `insertBlock`
 * does, then additionally refuses when the destination depth plus the
 * moved subtree's own height would exceed `blockDepthCeiling`, or the
 * destination section depth plus the subtree's own section height would
 * exceed `sectionNestingDepth` -- the moved subtree's own height is what
 * makes a move stricter than an insert (D-08, D-18). Resolves the new
 * `sort_order` via `sortOrderBetween`, rebalancing the destination sibling
 * list with `rebalancedOrders` first when `needsRebalance` says the gap has
 * closed. Recomputes every descendant's `depth` in one batched statement.
 * Records one `'move'`-kind revision for the moved block, capturing its
 * pre-move `block_type`, `parent_block_id` and `sort_order` (D-27); bumps
 * the owning page's `version`.
 */
export async function moveBlock(
  deps: PagesDeps,
  actor: AuditActor,
  input: MoveBlockInput,
): Promise<BlockRecord> {
  const now = deps.now ?? (() => new Date());
  const revisionCap = await getRevisionCap(deps.db);
  const before = await loadBlockSnapshot(deps.db, input.blockId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'block.move',
      entityType: 'page_block',
      entityId: input.blockId,
      ...(before === null ? {} : { before }),
    },
    async (tx) => {
      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.basePageVersion) {
        throw new StalePageVersionError(
          page.id,
          input.basePageVersion,
          page.version,
        );
      }
      assertPageWritable(
        [page],
        await getPageEditLocking(tx),
        actor.userId,
        now(),
      );

      const [current] = await tx
        .select()
        .from(pageBlocks)
        .where(eq(pageBlocks.id, input.blockId))
        .for('update');
      if (current === undefined) {
        throw new BlockNotFoundError(input.blockId);
      }
      if (current.version !== input.baseVersion) {
        throw new StaleBlockVersionError(
          input.blockId,
          input.baseVersion,
          current.version,
        );
      }

      let parentDefinition: BlockDefinition | null = null;
      let parentDepth: number | null = null;
      let parentSectionDepth = 0;
      if (input.newParentBlockId !== null) {
        const [parentRow] = await tx
          .select({ depth: pageBlocks.depth, blockType: pageBlocks.blockType })
          .from(pageBlocks)
          .where(eq(pageBlocks.id, input.newParentBlockId))
          .for('update');
        if (parentRow === undefined) {
          throw new BlockNotFoundError(input.newParentBlockId);
        }
        parentDepth = parentRow.depth;
        parentDefinition = getBlockDefinition(parentRow.blockType);
        parentSectionDepth = await countAncestorSections(
          tx,
          input.newParentBlockId,
        );
      }

      const subtreeRows = await walkSubtree(tx, input.blockId);
      const subtreeIds = new Set(subtreeRows.map((row) => row.id));

      if (
        input.newParentBlockId !== null &&
        subtreeIds.has(input.newParentBlockId)
      ) {
        throw new CircularMoveError(input.blockId, input.newParentBlockId);
      }

      const { height: subtreeHeight, sectionHeight: subtreeSectionHeight } =
        computeSubtreeShape(subtreeRows, input.blockId);

      const definition = getBlockDefinition(current.blockType);
      const ownerRef: OwnerRef = {
        ownerType: asOwnerType(current.ownerType),
        ownerId: current.ownerId,
        locale: current.locale,
      };
      assertPlacementAllowed({
        owner: ownerRef,
        child: definition,
        parent: parentDefinition,
        parentDepth,
        parentSectionDepth,
        sectionNestingDepth: deps.config.sectionNestingDepth,
        blockDepthCeiling: deps.config.blockDepthCeiling,
      });

      const movedBlockNewDepth = (parentDepth ?? -1) + 1;
      const finalDepth = movedBlockNewDepth + subtreeHeight;
      if (finalDepth > deps.config.blockDepthCeiling) {
        throw new BlockDepthExceededError(
          deps.config.blockDepthCeiling,
          finalDepth,
        );
      }
      const finalSectionDepth = parentSectionDepth + subtreeSectionHeight;
      if (finalSectionDepth > deps.config.sectionNestingDepth) {
        throw new SectionNestingDepthExceededError(
          deps.config.sectionNestingDepth,
          finalSectionDepth,
        );
      }

      const beforeOrder = await resolveSiblingSortOrder(
        tx,
        input.beforeSiblingId,
        input.newParentBlockId,
      );
      const afterOrder = await resolveSiblingSortOrder(
        tx,
        input.afterSiblingId,
        input.newParentBlockId,
      );
      let newSortOrder = sortOrderBetween(beforeOrder, afterOrder);
      if (needsRebalance(beforeOrder, afterOrder)) {
        const siblingCondition =
          input.newParentBlockId === null
            ? and(
                eq(pageBlocks.ownerType, current.ownerType),
                eq(pageBlocks.ownerId, current.ownerId),
                eq(pageBlocks.locale, current.locale),
                isNull(pageBlocks.parentBlockId),
              )
            : eq(pageBlocks.parentBlockId, input.newParentBlockId);
        const siblings = await tx
          .select({ id: pageBlocks.id })
          .from(pageBlocks)
          .where(and(siblingCondition, ne(pageBlocks.id, input.blockId)))
          .orderBy(asc(pageBlocks.sortOrder), asc(pageBlocks.id))
          .for('update');
        const rebalanced = rebalancedOrders(siblings.length);
        if (siblings.length > 0) {
          const valuesClause = sql.join(
            siblings.map(
              (sibling, index) =>
                sql`(${sibling.id}::uuid, ${rebalanced[index]}::integer)`,
            ),
            sql`, `,
          );
          await tx.execute(sql`
            UPDATE page_blocks SET sort_order = v.new_order
            FROM (VALUES ${valuesClause}) AS v(id, new_order)
            WHERE page_blocks.id = v.id
          `);
        }
        const beforeIndex =
          input.beforeSiblingId != null
            ? siblings.findIndex(
                (sibling) => sibling.id === input.beforeSiblingId,
              )
            : -1;
        const afterIndex =
          input.afterSiblingId != null
            ? siblings.findIndex(
                (sibling) => sibling.id === input.afterSiblingId,
              )
            : -1;
        const rebalancedBefore =
          beforeIndex >= 0 ? (rebalanced[beforeIndex] ?? null) : null;
        const rebalancedAfter =
          afterIndex >= 0 ? (rebalanced[afterIndex] ?? null) : null;
        newSortOrder = sortOrderBetween(rebalancedBefore, rebalancedAfter);
      }

      const updatedAt = now();
      const [movedRow] = await tx
        .update(pageBlocks)
        .set({
          parentBlockId: input.newParentBlockId,
          sortOrder: newSortOrder,
          depth: movedBlockNewDepth,
          version: sql`${pageBlocks.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(
          and(
            eq(pageBlocks.id, input.blockId),
            eq(pageBlocks.version, input.baseVersion),
          ),
        )
        .returning();
      if (movedRow === undefined) {
        throw new StaleBlockVersionError(
          input.blockId,
          input.baseVersion,
          current.version,
        );
      }

      // Recomputes every descendant's `depth` in ONE batched statement, keyed
      // on the descendant ids and their depth relative to the moved block
      // (already collected above) -- never a query per row. Extracted to
      // `subtree.ts`'s `rewriteDescendantDepths` (code review CR-02) so
      // `moveBlock` and `restoreRevisionBatch`'s `'move'`-kind replay share
      // one implementation; mirrors `pages.ts`'s `applySubtreeRewrite`, the
      // identical one-statement multi-row rewrite shape one level up the
      // tree.
      const descendantRows = subtreeRows.filter(
        (row) => row.id !== input.blockId,
      );
      await rewriteDescendantDepths(tx, movedBlockNewDepth, descendantRows);

      await recordBlockRevision(tx, {
        blockId: current.id,
        owner: ownerRef,
        revisionBatchId: newRevisionBatchId(),
        changeType: 'move',
        kind: 'save',
        blockType: current.blockType,
        parentBlockId: current.parentBlockId,
        sortOrder: current.sortOrder,
        depth: current.depth,
        props: current.props,
        schemaVersion: current.schemaVersion,
        authorId: actor.userId,
        createdAt: updatedAt,
      });

      await tx
        .update(pages)
        .set({ version: sql`${pages.version} + 1` })
        .where(eq(pages.id, page.id));

      await pruneBlockRevisions(tx, {
        pageId: page.id,
        locale: ownerRef.locale,
        cap: revisionCap,
      });

      const record = toBlockRecordFromRow(movedRow);
      return { result: record, after: record };
    },
  );
}

type DeleteSubtreeRow = {
  readonly id: string;
  readonly parentBlockId: string | null;
  readonly blockType: string;
  readonly props: unknown;
  readonly schemaVersion: number;
  readonly depth: number;
  readonly sortOrder: number;
};

/** Walks `rootBlockId` and every descendant in ONE recursive CTE query,
 * ordered depth-first via the same `sort_path` technique `readBlockTree`
 * uses -- `deleteBlock` records one revision per row in this order, before
 * any row is deleted (T-04-29: a discrimination check proves the ordering
 * is load-bearing). */
async function loadSubtreeForDelete(
  db: AuditDatabase,
  rootBlockId: string,
): Promise<readonly DeleteSubtreeRow[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, parent_block_id, block_type, props, schema_version, depth,
        sort_order, ARRAY[sort_order] AS sort_path
      FROM page_blocks
      WHERE id = ${rootBlockId}

      UNION ALL

      SELECT pb.id, pb.parent_block_id, pb.block_type, pb.props,
        pb.schema_version, pb.depth, pb.sort_order,
        subtree.sort_path || pb.sort_order
      FROM page_blocks pb
      JOIN subtree ON pb.parent_block_id = subtree.id
    )
    SELECT id, parent_block_id AS "parentBlockId", block_type AS "blockType",
      props, schema_version AS "schemaVersion", depth,
      sort_order AS "sortOrder"
    FROM subtree
    ORDER BY sort_path
  `);
  return resultRows(result).map((row) => ({
    id: asString(row.id, 'id'),
    parentBlockId: asNullableString(row.parentBlockId),
    blockType: asString(row.blockType, 'blockType'),
    props: row.props,
    schemaVersion: asNumber(row.schemaVersion, 'schemaVersion'),
    depth: asNumber(row.depth, 'depth'),
    sortOrder: asNumber(row.sortOrder, 'sortOrder'),
  }));
}

/** Counts existing `block_revisions` rows already referencing any of
 * `blockIds` -- the "how much history exists" half of `BlockDeleteImpact`,
 * shared by `computeBlockDeleteImpact` and `deleteBlock`'s own recompute. */
async function countExistingRevisions(
  db: AuditDatabase,
  blockIds: readonly string[],
): Promise<number> {
  if (blockIds.length === 0) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blockRevisions)
    .where(inArray(blockRevisions.blockId, [...blockIds]));
  return row?.count ?? 0;
}

export type BlockDeleteImpact = {
  readonly blockId: string;
  readonly blockCount: number;
  readonly blockTypes: readonly string[];
  readonly revisionCount: number;
};

/**
 * Reports what deleting `input.blockId` (and its whole subtree) would
 * touch -- read-only, writes nothing, in the
 * `computeEntryPermanentDeleteImpact` shape (`@plakboek/content`'s
 * `lifecycle.ts`). Walks the block and every descendant in one recursive
 * CTE query and counts how many existing `block_revisions` rows already
 * reference any of those block ids. Typed to accept a transaction handle
 * too, so `deleteBlock` recomputes this same shape of impact inside its own
 * transaction rather than trusting a caller's earlier preview (mirrors
 * `@plakboek/content`'s `computeEntryPermanentDeleteImpact`/
 * `deleteEntryPermanently` pair).
 */
export async function computeBlockDeleteImpact(
  db: AuditDatabase,
  input: { readonly blockId: string },
): Promise<BlockDeleteImpact> {
  const rows = await loadSubtreeForDelete(db, input.blockId);
  if (rows.length === 0) {
    throw new BlockNotFoundError(input.blockId);
  }
  const blockTypes = Object.freeze([
    ...new Set(rows.map((row) => row.blockType)),
  ]);
  const revisionCount = await countExistingRevisions(
    db,
    rows.map((row) => row.id),
  );
  return {
    blockId: input.blockId,
    blockCount: rows.length,
    blockTypes,
    revisionCount,
  };
}

export type DeleteBlockInput = {
  readonly blockId: string;
  readonly baseVersion: number;
  readonly pageId: string;
  readonly basePageVersion: number;
};

/**
 * Deletes a block and its whole subtree, keeping its history (a structural
 * change, D-38, D-27). Through `deps.recorder.run` (`pages:delete` /
 * `block.delete`): loads and locks the owning page `FOR UPDATE`, throwing
 * `StalePageVersionError` on a base-version mismatch; loads and locks the
 * block itself `FOR UPDATE`, throwing `StaleBlockVersionError` on a
 * mismatch; walks the block and every descendant in one recursive CTE
 * query (depth-first, recomputing the delete impact inside this same
 * transaction rather than trusting a caller's earlier
 * `computeBlockDeleteImpact` preview); records one `'delete'`-kind block
 * revision per collected row -- sharing one `revision_batch_id`, each
 * capturing that row's `block_type`, `parent_block_id`, `sort_order`,
 * `depth`, `props` and `schema_version` as they were -- strictly BEFORE the
 * delete statement runs; then a single `DELETE FROM page_blocks WHERE id =
 * ?` on the subtree's root, letting the `parent_block_id` cascade remove
 * every descendant and `block_revisions.block_id`'s `ON DELETE SET NULL`
 * keep every revision row readable with `block_id` null; bumps the owning
 * page's `version`. Returns the impact counts as both the result and the
 * audit `after` payload.
 */
export async function deleteBlock(
  deps: PagesDeps,
  actor: AuditActor,
  input: DeleteBlockInput,
): Promise<BlockDeleteImpact> {
  const now = deps.now ?? (() => new Date());
  const revisionCap = await getRevisionCap(deps.db);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:delete',
      action: 'block.delete',
      entityType: 'page_block',
      entityId: input.blockId,
    },
    async (tx) => {
      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.basePageVersion) {
        throw new StalePageVersionError(
          page.id,
          input.basePageVersion,
          page.version,
        );
      }
      assertPageWritable(
        [page],
        await getPageEditLocking(tx),
        actor.userId,
        now(),
      );

      const [current] = await tx
        .select()
        .from(pageBlocks)
        .where(eq(pageBlocks.id, input.blockId))
        .for('update');
      if (current === undefined) {
        throw new BlockNotFoundError(input.blockId);
      }
      if (current.version !== input.baseVersion) {
        throw new StaleBlockVersionError(
          input.blockId,
          input.baseVersion,
          current.version,
        );
      }

      const rows = await loadSubtreeForDelete(tx, input.blockId);
      const blockTypes = Object.freeze([
        ...new Set(rows.map((row) => row.blockType)),
      ]);
      const revisionCount = await countExistingRevisions(
        tx,
        rows.map((row) => row.id),
      );

      const ownerRef: OwnerRef = {
        ownerType: asOwnerType(current.ownerType),
        ownerId: current.ownerId,
        locale: current.locale,
      };
      const revisionBatchId = newRevisionBatchId();
      const deletedAt = now();
      for (const row of rows) {
        await recordBlockRevision(tx, {
          blockId: row.id,
          owner: ownerRef,
          revisionBatchId,
          changeType: 'delete',
          kind: 'save',
          blockType: row.blockType,
          parentBlockId: row.parentBlockId,
          sortOrder: row.sortOrder,
          depth: row.depth,
          props: row.props,
          schemaVersion: row.schemaVersion,
          authorId: actor.userId,
          createdAt: deletedAt,
        });
      }

      await tx.delete(pageBlocks).where(eq(pageBlocks.id, input.blockId));

      await tx
        .update(pages)
        .set({ version: sql`${pages.version} + 1` })
        .where(eq(pages.id, page.id));

      await pruneBlockRevisions(tx, {
        pageId: page.id,
        locale: ownerRef.locale,
        cap: revisionCap,
      });

      const impact: BlockDeleteImpact = {
        blockId: input.blockId,
        blockCount: rows.length,
        blockTypes,
        revisionCount,
      };
      return { result: impact, after: impact };
    },
  );
}
