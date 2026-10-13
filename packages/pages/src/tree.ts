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
import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { PagesDeps, PagesHooks } from './config.js';
import {
  readStoredLayout,
  validateBlockLayout,
  type BlockLayout,
} from './layout.js';
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
  loadParentForPlacement,
  SectionNestingDepthExceededError,
} from './placement.js';
import {
  getBlockDefinition,
  getColumnDefinition,
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
  type PageRecord,
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
    layout: readStoredLayout(row.layout),
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
  readonly layout: BlockLayout | null;
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
    layout: readStoredLayout(row.layout),
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
    layout: raw.row.layout,
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
        props, layout, schema_version, depth, sort_order, version, created_at,
        updated_at, ARRAY[sort_order] AS sort_path
      FROM page_blocks
      WHERE owner_type = ${owner.ownerType}
        AND owner_id = ${owner.ownerId}
        AND locale = ${owner.locale}
        AND parent_block_id IS NULL

      UNION ALL

      SELECT
        pb.id, pb.parent_block_id, pb.owner_type, pb.owner_id, pb.locale,
        pb.block_type, pb.props, pb.layout, pb.schema_version, pb.depth,
        pb.sort_order, pb.version, pb.created_at, pb.updated_at,
        tree.sort_path || pb.sort_order
      FROM page_blocks pb
      JOIN tree ON pb.parent_block_id = tree.id
    )
    SELECT
      id, parent_block_id AS "parentBlockId", owner_type AS "ownerType",
      owner_id AS "ownerId", locale, block_type AS "blockType", props, layout,
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

/**
 * What every transactional write body below needs, already loaded by its
 * caller: the locked page, the owner tuple the tree belongs to, the one
 * revision batch id every revision of the call shares (D-26) and the one
 * timestamp the call stamps its rows with. The bodies never bump the page
 * version, never prune revisions and never open a transaction themselves:
 * the public single-operation functions below and `applyBlockEdit`
 * (edit-batch.ts) each do those once per call. Internal wiring, withheld
 * from the barrel.
 */
export type WriteContext = {
  readonly deps: PagesDeps;
  readonly actor: AuditActor;
  readonly page: PageRecord;
  readonly ownerRef: OwnerRef;
  readonly revisionBatchId: string;
  readonly now: Date;
};

type PageBlockRow = typeof pageBlocks.$inferSelect;

/** Loads and locks one block `FOR UPDATE`. A non-null `expectedVersion`
 * must equal the stored version (`StaleBlockVersionError` otherwise);
 * `null` skips the comparison, for a batch operation on a block an earlier
 * operation of the same batch already version-checked and bumped. */
export async function loadBlockForUpdate(
  tx: AuditTransaction,
  blockId: string,
  expectedVersion: number | null,
): Promise<PageBlockRow> {
  const [current] = await tx
    .select()
    .from(pageBlocks)
    .where(eq(pageBlocks.id, blockId))
    .for('update');
  if (current === undefined) {
    throw new BlockNotFoundError(blockId);
  }
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new StaleBlockVersionError(blockId, expectedVersion, current.version);
  }
  return current;
}

/** The condition selecting one sibling list: every child of a block, or the
 * roots of one owner's tree. */
function siblingListCondition(
  owner: OwnerRef,
  parentBlockId: string | null,
): SQL | undefined {
  return parentBlockId === null
    ? and(
        eq(pageBlocks.ownerType, owner.ownerType),
        eq(pageBlocks.ownerId, owner.ownerId),
        eq(pageBlocks.locale, owner.locale),
        isNull(pageBlocks.parentBlockId),
      )
    : eq(pageBlocks.parentBlockId, parentBlockId);
}

/** Always throws: a named sibling is not in the destination list, which is
 * either because it does not exist or because it belongs to another parent
 * (code review WR-02). */
async function refuseSiblingReference(
  tx: AuditTransaction,
  siblingId: string,
  expectedParentBlockId: string | null,
): Promise<never> {
  const [row] = await tx
    .select({ parentBlockId: pageBlocks.parentBlockId })
    .from(pageBlocks)
    .where(eq(pageBlocks.id, siblingId));
  if (row === undefined) {
    throw new BlockNotFoundError(siblingId);
  }
  throw new InvalidSiblingReferenceError(
    siblingId,
    expectedParentBlockId,
    row.parentBlockId,
  );
}

/**
 * Resolves the `sort_order` a block takes under `parentBlockId`, from the
 * siblings that end up directly before and after it. With neither named it
 * goes last. With one named, the missing neighbour is read from the stored
 * list, so "after X" lands directly after X and never on top of whatever
 * follows it. Every named id must belong to that exact sibling list
 * (`BlockNotFoundError` / `InvalidSiblingReferenceError`). `excludeId` is
 * the block being moved, left out of the list so it never counts as its own
 * neighbour. When no integer fits between the two orders, the whole list is
 * renumbered in one statement first (`rebalancedOrders`), and the position
 * is computed against the fresh numbers. Shared by insert and move so the
 * ordering arithmetic exists once.
 */
export async function resolvePositionSortOrder(
  tx: AuditTransaction,
  owner: OwnerRef,
  parentBlockId: string | null,
  previousSiblingId: string | null | undefined,
  nextSiblingId: string | null | undefined,
  excludeId: string | null,
): Promise<number> {
  const listCondition = siblingListCondition(owner, parentBlockId);
  const condition =
    excludeId === null
      ? listCondition
      : and(listCondition, ne(pageBlocks.id, excludeId));
  const previousId = previousSiblingId ?? null;
  const nextId = nextSiblingId ?? null;

  if (previousId === null && nextId === null) {
    const [siblingMax] = await tx
      .select({ max: sql<number | null>`max(${pageBlocks.sortOrder})` })
      .from(pageBlocks)
      .where(condition);
    return nextSortOrder(siblingMax?.max ?? null);
  }

  const siblings = await tx
    .select({ id: pageBlocks.id, sortOrder: pageBlocks.sortOrder })
    .from(pageBlocks)
    .where(condition)
    .orderBy(asc(pageBlocks.sortOrder), asc(pageBlocks.id))
    .for('update');

  const indexOfNamed = async (siblingId: string): Promise<number> => {
    const index = siblings.findIndex((sibling) => sibling.id === siblingId);
    if (index < 0) {
      return await refuseSiblingReference(tx, siblingId, parentBlockId);
    }
    return index;
  };
  const previousIndex =
    previousId === null ? -1 : await indexOfNamed(previousId);
  const nextIndex = nextId === null ? -1 : await indexOfNamed(nextId);

  let beforeIndex: number;
  let afterIndex: number;
  if (previousId !== null && nextId !== null) {
    beforeIndex = previousIndex;
    afterIndex = nextIndex;
  } else if (previousId !== null) {
    beforeIndex = previousIndex;
    afterIndex = previousIndex + 1;
  } else {
    afterIndex = nextIndex;
    beforeIndex = nextIndex - 1;
  }

  const orderAt = (index: number, orders: readonly number[]): number | null =>
    index >= 0 && index < orders.length ? (orders[index] ?? null) : null;
  const before = orderAt(
    beforeIndex,
    siblings.map((sibling) => sibling.sortOrder),
  );
  const after = orderAt(
    afterIndex,
    siblings.map((sibling) => sibling.sortOrder),
  );
  // Placing before a first sibling whose order is 0 has no integer left
  // below it either.
  const gapClosed =
    needsRebalance(before, after) ||
    (before === null && after !== null && after < 1);
  if (!gapClosed) return sortOrderBetween(before, after);

  const rebalanced = rebalancedOrders(siblings.length);
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
  return sortOrderBetween(
    orderAt(beforeIndex, rebalanced),
    orderAt(afterIndex, rebalanced),
  );
}

export type InsertBlockInput = {
  readonly owner: OwnerRef;
  readonly blockType: string;
  readonly parentBlockId: string | null;
  readonly sortOrder?: number;
  readonly props?: unknown;
  /** Section ratio/alignment or a fill flag (D-33), validated against the
   * block's declaration and the configured column presets. */
  readonly layout?: unknown;
  readonly basePageVersion: number;
};

/** What one insert needs once the page and owner are settled. A supplied
 * `id` is inserted as given (a client-chosen uuid, so an undo can restore a
 * block under its original id); otherwise the database picks one. Position
 * is, in order of precedence, an explicit `sortOrder`, the named neighbours,
 * or last. */
export type InsertInTransactionInput = {
  readonly id?: string;
  readonly blockType: string;
  readonly parentBlockId: string | null;
  readonly props?: unknown;
  readonly layout?: unknown;
  readonly sortOrder?: number;
  readonly previousSiblingId?: string | null;
  readonly nextSiblingId?: string | null;
};

/**
 * The body of one insert, inside the caller's transaction: resolves the
 * block definition, loads and locks the parent when given and derives
 * `depth` as `parent.depth + 1` (`0` at the root), calls
 * `assertPlacementAllowed` (placement.ts, BLOCK-05, D-08, D-18, D-19) before
 * any write, validates `props` leniently (a required property may still be
 * empty in the working tree, D-21) and `layout` against the column presets,
 * inserts with `schema_version` set to the registry's current version and
 * records a `'create'` revision under the context's batch id. Does not
 * bump the page version or prune.
 */
export async function insertBlockInTransaction(
  tx: AuditTransaction,
  ctx: WriteContext,
  input: InsertInTransactionInput,
): Promise<BlockRecord> {
  const { deps, actor, ownerRef } = ctx;
  const definition = getBlockDefinition(input.blockType);

  let parentDefinition: BlockDefinition | null = null;
  let sectionDefinition: BlockDefinition | null = null;
  let parentDepth: number | null = null;
  let parentSectionDepth = 0;
  if (input.parentBlockId !== null) {
    const loaded = await loadParentForPlacement(tx, input.parentBlockId);
    if (loaded === null) {
      throw new BlockNotFoundError(input.parentBlockId);
    }
    parentDepth = loaded.parentDepth;
    parentDefinition = loaded.parentDefinition;
    sectionDefinition = loaded.sectionDefinition;
    parentSectionDepth = loaded.parentSectionDepth;
  }
  const depth = (parentDepth ?? -1) + 1;

  assertPlacementAllowed({
    owner: ownerRef,
    child: definition,
    parent: parentDefinition,
    section: sectionDefinition,
    columnsEnabled: getColumnDefinition() !== null,
    parentDepth,
    parentSectionDepth,
    sectionNestingDepth: deps.config.sectionNestingDepth,
    blockDepthCeiling: deps.config.blockDepthCeiling,
  });

  const validatedProps = validateBlockProps(definition, input.props ?? {}, {
    allowMissingRequired: true,
  });
  const validatedLayout = validateBlockLayout(
    definition,
    input.layout,
    deps.config.columnPresets,
  );

  const sortOrder =
    input.sortOrder ??
    (await resolvePositionSortOrder(
      tx,
      ownerRef,
      input.parentBlockId,
      input.previousSiblingId,
      input.nextSiblingId,
      null,
    ));

  const [row] = await tx
    .insert(pageBlocks)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      ownerType: ownerRef.ownerType,
      ownerId: ownerRef.ownerId,
      locale: ownerRef.locale,
      parentBlockId: input.parentBlockId,
      blockType: input.blockType,
      props: validatedProps,
      layout: validatedLayout,
      schemaVersion: definition.schemaVersion,
      depth,
      sortOrder,
      version: 1,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  if (row === undefined) {
    throw new Error('@plakboek/pages: block insert returned no row');
  }
  const record = toBlockRecordFromRow(row);

  await recordBlockRevision(tx, {
    blockId: record.id,
    owner: ownerRef,
    revisionBatchId: ctx.revisionBatchId,
    changeType: 'create',
    kind: 'save',
    blockType: record.blockType,
    parentBlockId: record.parentBlockId,
    sortOrder: record.sortOrder,
    depth: record.depth,
    props: record.props,
    layout: record.layout,
    schemaVersion: record.schemaVersion,
    authorId: actor.userId,
    createdAt: ctx.now,
  });

  return record;
}

/**
 * Inserts a block (a structural change, D-38). Through `deps.recorder.run`
 * (`pages:edit` / `block.insert`): resolves `input.blockType`'s definition
 * first, before any row is loaded, so an unregistered type refuses
 * immediately (`UnknownBlockTypeError`); loads and locks the owning page
 * `FOR UPDATE`, throwing `StalePageVersionError` when `page.version !==
 * input.basePageVersion`; then runs `insertBlockInTransaction` (parent
 * load, placement, lenient props validation, `sortOrder` as `max(sort_order)
 * + 1000` among siblings when not supplied, the `'create'` revision) and
 * bumps the owning page's `version`.
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
      getBlockDefinition(input.blockType);

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

      const record = await insertBlockInTransaction(
        tx,
        {
          deps,
          actor,
          page,
          ownerRef: input.owner,
          revisionBatchId: newRevisionBatchId(),
          now: now(),
        },
        {
          blockType: input.blockType,
          parentBlockId: input.parentBlockId,
          ...(input.sortOrder === undefined
            ? {}
            : { sortOrder: input.sortOrder }),
          ...(input.props === undefined ? {} : { props: input.props }),
          ...(input.layout === undefined ? {} : { layout: input.layout }),
        },
      );

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
  /** Undefined keeps the stored layout, null clears it, anything else is
   * validated and replaces it (D-33). */
  readonly layout?: unknown;
};

/** What one update needs once the block is loaded and locked. When the
 * `props` key is present the stored props are replaced by the validated
 * value; when it is absent they are left alone. `layout` follows the same
 * rule as `UpdateBlockPropsInput.layout`. */
export type UpdateInTransactionInput = {
  readonly current: PageBlockRow;
  readonly props?: unknown;
  readonly layout?: unknown;
};

/**
 * The body of one property/layout edit, inside the caller's transaction,
 * for a block the caller has already loaded `FOR UPDATE` and version-
 * checked: validates leniently (D-21), writes the new values with
 * `version + 1` and records an `'update'` revision under the context's
 * batch id. Never touches the page version.
 */
export async function updateBlockInTransaction(
  tx: AuditTransaction,
  ctx: WriteContext,
  input: UpdateInTransactionInput,
): Promise<BlockRecord> {
  const { deps, actor, ownerRef } = ctx;
  const { current } = input;

  const definition = getBlockDefinition(current.blockType);
  const validatedProps =
    'props' in input
      ? validateBlockProps(definition, input.props, {
          allowMissingRequired: true,
        })
      : undefined;
  const validatedLayout =
    input.layout === undefined
      ? undefined
      : validateBlockLayout(
          definition,
          input.layout,
          deps.config.columnPresets,
        );

  const [row] = await tx
    .update(pageBlocks)
    .set({
      ...(validatedProps === undefined ? {} : { props: validatedProps }),
      ...(validatedLayout === undefined ? {} : { layout: validatedLayout }),
      version: sql`${pageBlocks.version} + 1`,
      updatedAt: ctx.now,
      updatedBy: actor.userId,
    })
    .where(
      and(
        eq(pageBlocks.id, current.id),
        eq(pageBlocks.version, current.version),
      ),
    )
    .returning();
  if (row === undefined) {
    throw new StaleBlockVersionError(
      current.id,
      current.version,
      current.version,
    );
  }
  const record = toBlockRecordFromRow(row);

  await recordBlockRevision(tx, {
    blockId: record.id,
    owner: ownerRef,
    revisionBatchId: ctx.revisionBatchId,
    changeType: 'update',
    kind: 'save',
    blockType: record.blockType,
    parentBlockId: record.parentBlockId,
    sortOrder: record.sortOrder,
    depth: record.depth,
    props: record.props,
    layout: record.layout,
    schemaVersion: record.schemaVersion,
    authorId: actor.userId,
    createdAt: ctx.now,
  });

  return record;
}

/**
 * Edits a block's properties (a property-only change, D-38 -- does *not*
 * touch the owning page's `version`). Through `deps.recorder.run`
 * (`pages:edit` / `block.update`): loads and locks the block `FOR UPDATE`,
 * throwing `StaleBlockVersionError` when the version differs; checks the
 * page lock; then runs `updateBlockInTransaction` (validation through
 * `validateBlockProps`, the version-guarded `UPDATE ... SET props, version
 * = version + 1, updated_at, updated_by`, the `'update'` revision).
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
      const current = await loadBlockForUpdate(
        tx,
        input.blockId,
        input.baseVersion,
      );

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
      const checkedAt = now();
      assertPageWritable(
        [page],
        await getPageEditLocking(tx),
        actor.userId,
        checkedAt,
      );

      const ownerRef: OwnerRef = {
        ownerType: asOwnerType(current.ownerType),
        ownerId: current.ownerId,
        locale: current.locale,
      };
      const record = await updateBlockInTransaction(
        tx,
        {
          deps,
          actor,
          page,
          ownerRef,
          revisionBatchId: newRevisionBatchId(),
          now: now(),
        },
        {
          current,
          props: input.props,
          ...(input.layout === undefined ? {} : { layout: input.layout }),
        },
      );

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

/** Thrown by `moveBlock` (and a batch insert or move) when a named
 * neighbour does not actually belong to the destination parent -- e.g. a
 * caller-supplied id left over from an unrelated parent's sibling list.
 * Without this check the id would still resolve (it is loaded purely by
 * id), and the block's `sort_order` would be computed relative to a block
 * outside its real sibling list (code review WR-02). */
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

export type MoveBlockInput = {
  readonly blockId: string;
  readonly baseVersion: number;
  readonly pageId: string;
  readonly basePageVersion: number;
  readonly newParentBlockId: string | null;
  /** The sibling that ends up directly before the moved block. */
  readonly beforeSiblingId?: string | null;
  /** The sibling that ends up directly after the moved block. */
  readonly afterSiblingId?: string | null;
};

/** What one move needs once the block is loaded and locked. */
export type MoveInTransactionInput = {
  readonly current: PageBlockRow;
  readonly newParentBlockId: string | null;
  readonly previousSiblingId?: string | null;
  readonly nextSiblingId?: string | null;
};

/**
 * The body of one move, inside the caller's transaction, for a block the
 * caller has already loaded `FOR UPDATE` and version-checked. Loads and
 * locks the destination parent when non-null; walks the moved block's
 * descendants in one recursive CTE query, collecting the subtree's own
 * height and its section-only height; refuses `CircularMoveError` when the
 * destination is the moved block itself or one of its own descendants;
 * re-runs `assertPlacementAllowed` against the destination exactly as an
 * insert does, then additionally refuses when the destination depth plus
 * the moved subtree's own height would exceed `blockDepthCeiling`, or the
 * destination section depth plus the subtree's own section height would
 * exceed `sectionNestingDepth` -- the moved subtree's own height is what
 * makes a move stricter than an insert (D-08, D-18). Resolves the new
 * `sort_order` through `resolvePositionSortOrder`, recomputes every
 * descendant's `depth` in one batched statement (RESEARCH Pitfall 6) and
 * records one `'move'`-kind revision capturing the block's pre-move
 * `parent_block_id` and `sort_order` (D-27). Does not bump the page version
 * or prune.
 */
export async function moveBlockInTransaction(
  tx: AuditTransaction,
  ctx: WriteContext,
  input: MoveInTransactionInput,
): Promise<BlockRecord> {
  const { deps, actor, ownerRef, now: updatedAt } = ctx;
  const { current } = input;
  const blockId = current.id;

  let parentDefinition: BlockDefinition | null = null;
  let sectionDefinition: BlockDefinition | null = null;
  let parentDepth: number | null = null;
  let parentSectionDepth = 0;
  if (input.newParentBlockId !== null) {
    const loaded = await loadParentForPlacement(tx, input.newParentBlockId);
    if (loaded === null) {
      throw new BlockNotFoundError(input.newParentBlockId);
    }
    parentDepth = loaded.parentDepth;
    parentDefinition = loaded.parentDefinition;
    sectionDefinition = loaded.sectionDefinition;
    parentSectionDepth = loaded.parentSectionDepth;
  }

  const subtreeRows = await walkSubtree(tx, blockId);
  const subtreeIds = new Set(subtreeRows.map((row) => row.id));

  if (
    input.newParentBlockId !== null &&
    subtreeIds.has(input.newParentBlockId)
  ) {
    throw new CircularMoveError(blockId, input.newParentBlockId);
  }

  const { height: subtreeHeight, sectionHeight: subtreeSectionHeight } =
    computeSubtreeShape(subtreeRows, blockId);

  const definition = getBlockDefinition(current.blockType);
  assertPlacementAllowed({
    owner: ownerRef,
    child: definition,
    parent: parentDefinition,
    section: sectionDefinition,
    columnsEnabled: getColumnDefinition() !== null,
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

  const newSortOrder = await resolvePositionSortOrder(
    tx,
    ownerRef,
    input.newParentBlockId,
    input.previousSiblingId,
    input.nextSiblingId,
    blockId,
  );

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
      and(eq(pageBlocks.id, blockId), eq(pageBlocks.version, current.version)),
    )
    .returning();
  if (movedRow === undefined) {
    throw new StaleBlockVersionError(blockId, current.version, current.version);
  }

  // Recomputes every descendant's `depth` in ONE batched statement, keyed
  // on the descendant ids and their depth relative to the moved block
  // (already collected above) -- never a query per row. Extracted to
  // `subtree.ts`'s `rewriteDescendantDepths` (code review CR-02) so
  // `moveBlock` and `restoreRevisionBatch`'s `'move'`-kind replay share
  // one implementation; mirrors `pages.ts`'s `applySubtreeRewrite`, the
  // identical one-statement multi-row rewrite shape one level up the
  // tree.
  const descendantRows = subtreeRows.filter((row) => row.id !== blockId);
  await rewriteDescendantDepths(tx, movedBlockNewDepth, descendantRows);

  await recordBlockRevision(tx, {
    blockId: current.id,
    owner: ownerRef,
    revisionBatchId: ctx.revisionBatchId,
    changeType: 'move',
    kind: 'save',
    blockType: current.blockType,
    parentBlockId: current.parentBlockId,
    sortOrder: current.sortOrder,
    depth: current.depth,
    props: current.props,
    layout: readStoredLayout(current.layout),
    schemaVersion: current.schemaVersion,
    authorId: actor.userId,
    createdAt: updatedAt,
  });

  return toBlockRecordFromRow(movedRow);
}

/**
 * Moves a block and its whole subtree to a new parent and a new position
 * among its siblings, in one transaction (a structural change, D-38). Through
 * `deps.recorder.run` (`pages:edit` / `block.move`), in order: loads and
 * locks the owning page `FOR UPDATE`, throwing `StalePageVersionError` on a
 * base-version mismatch (a move is a structural change, so it takes the page
 * version as well as the block's own); checks the page lock; loads and locks
 * the moved block `FOR UPDATE`, throwing `StaleBlockVersionError` on a
 * mismatch; runs `moveBlockInTransaction` (destination, placement, subtree
 * height checks, ordering with rebalancing, descendant depth rewrite, the
 * `'move'` revision); bumps the owning page's `version`.
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

      const current = await loadBlockForUpdate(
        tx,
        input.blockId,
        input.baseVersion,
      );
      const ownerRef: OwnerRef = {
        ownerType: asOwnerType(current.ownerType),
        ownerId: current.ownerId,
        locale: current.locale,
      };

      const record = await moveBlockInTransaction(
        tx,
        {
          deps,
          actor,
          page,
          ownerRef,
          revisionBatchId: newRevisionBatchId(),
          now: now(),
        },
        {
          current,
          newParentBlockId: input.newParentBlockId,
          previousSiblingId: input.beforeSiblingId,
          nextSiblingId: input.afterSiblingId,
        },
      );

      await tx
        .update(pages)
        .set({ version: sql`${pages.version} + 1` })
        .where(eq(pages.id, page.id));

      await pruneBlockRevisions(tx, {
        pageId: page.id,
        locale: ownerRef.locale,
        cap: revisionCap,
      });

      return { result: record, after: record };
    },
  );
}

type DeleteSubtreeRow = {
  readonly id: string;
  readonly parentBlockId: string | null;
  readonly blockType: string;
  readonly props: unknown;
  readonly layout: BlockLayout | null;
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
      SELECT id, parent_block_id, block_type, props, layout, schema_version,
        depth, sort_order, ARRAY[sort_order] AS sort_path
      FROM page_blocks
      WHERE id = ${rootBlockId}

      UNION ALL

      SELECT pb.id, pb.parent_block_id, pb.block_type, pb.props, pb.layout,
        pb.schema_version, pb.depth, pb.sort_order,
        subtree.sort_path || pb.sort_order
      FROM page_blocks pb
      JOIN subtree ON pb.parent_block_id = subtree.id
    )
    SELECT id, parent_block_id AS "parentBlockId", block_type AS "blockType",
      props, layout, schema_version AS "schemaVersion", depth,
      sort_order AS "sortOrder"
    FROM subtree
    ORDER BY sort_path
  `);
  return resultRows(result).map((row) => ({
    id: asString(row.id, 'id'),
    parentBlockId: asNullableString(row.parentBlockId),
    blockType: asString(row.blockType, 'blockType'),
    props: row.props,
    layout: readStoredLayout(row.layout),
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

/** What a subtree delete removed: every row it recorded a `'delete'`
 * revision for (root first, depth-first), and how many revisions already
 * referenced those blocks before this call recorded its own. */
export type DeleteSubtreeResult = {
  readonly rows: readonly DeleteSubtreeRow[];
  readonly existingRevisionCount: number;
};

/**
 * The body of one subtree delete, inside the caller's transaction, for a
 * block the caller has already loaded `FOR UPDATE` and version-checked
 * (D-27): walks the block and every descendant in one recursive CTE query,
 * records one `'delete'`-kind revision per row -- sharing the context's
 * batch id, each capturing that row's `block_type`, `parent_block_id`,
 * `sort_order`, `depth`, `props`, `layout` and `schema_version` as they
 * were -- strictly BEFORE the delete statement runs, then removes the root
 * with one `DELETE`, letting the `parent_block_id` cascade remove every
 * descendant and `block_revisions.block_id`'s `ON DELETE SET NULL` keep
 * every revision row readable. Does not bump the page version or prune.
 */
export async function deleteSubtreeInTransaction(
  tx: AuditTransaction,
  ctx: WriteContext,
  input: { readonly current: PageBlockRow },
): Promise<DeleteSubtreeResult> {
  const { actor, ownerRef } = ctx;
  const rows = await loadSubtreeForDelete(tx, input.current.id);
  const existingRevisionCount = await countExistingRevisions(
    tx,
    rows.map((row) => row.id),
  );

  for (const row of rows) {
    await recordBlockRevision(tx, {
      blockId: row.id,
      owner: ownerRef,
      revisionBatchId: ctx.revisionBatchId,
      changeType: 'delete',
      kind: 'save',
      blockType: row.blockType,
      parentBlockId: row.parentBlockId,
      sortOrder: row.sortOrder,
      depth: row.depth,
      props: row.props,
      layout: row.layout,
      schemaVersion: row.schemaVersion,
      authorId: actor.userId,
      createdAt: ctx.now,
    });
  }

  await tx.delete(pageBlocks).where(eq(pageBlocks.id, input.current.id));

  return { rows, existingRevisionCount };
}

/**
 * Deletes a block and its whole subtree, keeping its history (a structural
 * change, D-38, D-27). Through `deps.recorder.run` (`pages:delete` /
 * `block.delete`): loads and locks the owning page `FOR UPDATE`, throwing
 * `StalePageVersionError` on a base-version mismatch; checks the page lock;
 * loads and locks the block itself `FOR UPDATE`, throwing
 * `StaleBlockVersionError` on a mismatch; runs `deleteSubtreeInTransaction`
 * (recomputing the delete impact inside this same transaction rather than
 * trusting a caller's earlier `computeBlockDeleteImpact` preview); bumps the
 * owning page's `version`. Returns the impact counts as both the result and
 * the audit `after` payload.
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

      const current = await loadBlockForUpdate(
        tx,
        input.blockId,
        input.baseVersion,
      );
      const ownerRef: OwnerRef = {
        ownerType: asOwnerType(current.ownerType),
        ownerId: current.ownerId,
        locale: current.locale,
      };

      const { rows, existingRevisionCount } = await deleteSubtreeInTransaction(
        tx,
        {
          deps,
          actor,
          page,
          ownerRef,
          revisionBatchId: newRevisionBatchId(),
          now: now(),
        },
        { current },
      );
      const blockTypes = Object.freeze([
        ...new Set(rows.map((row) => row.blockType)),
      ]);

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
        revisionCount: existingRevisionCount,
      };
      return { result: impact, after: impact };
    },
  );
}
