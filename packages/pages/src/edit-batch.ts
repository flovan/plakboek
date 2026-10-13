/**
 * The editor's one compound write (D-25): a batch of insert, update, move
 * and delete operations against a single page, applied in one transaction
 * with one revision batch id, one audit row and one page version bump -- or
 * not at all. Each autosave is one call here, so an action made of several
 * steps (add a column and reset the layout, delete a section and later undo
 * it under the original ids, move a block across a section boundary) can
 * never be left half-applied.
 *
 * The single-operation functions in `tree.ts` open their own transaction and
 * trust the ids they are given. A batch comes from a client, so every block
 * id, parent id and sibling id it names is checked against the page being
 * edited before anything is written: a block that belongs to another page,
 * another locale, or does not exist refuses the whole batch, so a locked
 * page's blocks can never be changed through an unlocked page's id.
 *
 * A batch changes the working tree only. It never writes a publication,
 * never changes what a page serves and never registers a cache purge:
 * visitors see a change only when the page is published (D-25).
 *
 * The transactional bodies the batch is built from (`insertBlockInTransaction`
 * and friends in `tree.ts`) are internal wiring and stay out of the package
 * barrel.
 */
import {
  PermissionDeniedError,
  type AuditActor,
  type AuditTransaction,
} from '@plakboek/auth';
import { getRevisionCap } from '@plakboek/content';
import { eq, inArray, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { assertPageWritable } from './locks.js';
import { loadPageForUpdate, StalePageVersionError } from './pages.js';
import { newRevisionBatchId, pruneBlockRevisions } from './revisions.js';
import { pageBlocks, pages } from './schema.js';
import { getPageEditLocking } from './settings.js';
import {
  BlockNotFoundError,
  deleteSubtreeInTransaction,
  insertBlockInTransaction,
  loadBlockForUpdate,
  moveBlockInTransaction,
  StaleBlockVersionError,
  updateBlockInTransaction,
  type WriteContext,
} from './tree.js';
import type { OwnerRef, PageRecord } from './types.js';

/** At most this many operations in one batch. */
export const BLOCK_EDIT_MAX_OPS = 50;

/** At most this many blocks inserted by one batch, subtrees included. */
export const BLOCK_EDIT_MAX_NODES = 500;

/** Where a block goes: under `parentId` (`null` for the page root), between
 * the two named siblings. With neither named it goes last. */
export type BlockEditPosition = {
  readonly parentId: string | null;
  readonly previousSiblingId?: string | null;
  readonly nextSiblingId?: string | null;
};

/** One block to insert, with an optional subtree. A supplied `id` must be a
 * lowercase uuid that no block uses yet; it lets a client name a block
 * before the server has answered, and lets an undo put a deleted block back
 * under its original id. */
export type BlockEditNode = {
  readonly id?: string;
  readonly type: string;
  readonly props?: unknown;
  readonly layout?: unknown;
  readonly children?: readonly BlockEditNode[];
};

export type BlockEditOp =
  | {
      readonly op: 'insert';
      readonly position: BlockEditPosition;
      readonly node: BlockEditNode;
    }
  | {
      readonly op: 'update';
      readonly blockId: string;
      readonly baseVersion: number;
      readonly props?: unknown;
      readonly layout?: unknown;
    }
  | {
      readonly op: 'move';
      readonly blockId: string;
      readonly baseVersion: number;
      readonly position: BlockEditPosition;
    }
  | {
      readonly op: 'delete';
      readonly blockId: string;
      readonly baseVersion: number;
    };

export type BlockEditInput = {
  readonly pageId: string;
  readonly basePageVersion: number;
  readonly ops: readonly BlockEditOp[];
};

export type BlockEditResult = {
  /** The page's version after the batch. */
  readonly pageVersion: number;
  readonly revisionBatchId: string;
  readonly createdIds: readonly string[];
  readonly deletedIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly movedIds: readonly string[];
  /** Every old and new parent of an inserted, moved or deleted block
   * (`null` for the page root), so a caller can find the sections the
   * batch touched. */
  readonly touchedParentIds: readonly (string | null)[];
};

/** Thrown when a batch names a block that is not part of the page being
 * edited: another page, another locale or another owner type. Nothing has
 * been written. Carries the block id only. */
export class BlockOwnershipError extends Error {
  readonly blockId: string;

  constructor(blockId: string) {
    super(
      `@plakboek/pages: block "${blockId}" does not belong to the page being edited`,
    );
    this.name = 'BlockOwnershipError';
    this.blockId = blockId;
  }
}

/** Thrown when an inserted node carries an id that is already in use,
 * whether by an existing block or by another node of the same batch. A
 * re-sent insert therefore never creates a second block. */
export class BlockIdConflictError extends Error {
  readonly blockId: string;

  constructor(blockId: string) {
    super(`@plakboek/pages: a block with id "${blockId}" already exists`);
    this.name = 'BlockIdConflictError';
    this.blockId = blockId;
  }
}

/** Thrown before any query when a batch is empty, holds more than
 * `BLOCK_EDIT_MAX_OPS` operations or inserts more than
 * `BLOCK_EDIT_MAX_NODES` blocks. */
export class BlockEditLimitError extends Error {
  readonly limit: 'ops' | 'nodes' | 'empty';

  constructor(limit: 'ops' | 'nodes' | 'empty') {
    super(
      limit === 'empty'
        ? '@plakboek/pages: a block edit needs at least one operation'
        : limit === 'ops'
          ? `@plakboek/pages: a block edit holds at most ${BLOCK_EDIT_MAX_OPS} operations`
          : `@plakboek/pages: a block edit inserts at most ${BLOCK_EDIT_MAX_NODES} blocks`,
    );
    this.name = 'BlockEditLimitError';
    this.limit = limit;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNIQUE_VIOLATION = '23505';
const BLOCK_PRIMARY_KEY_CONSTRAINT = 'page_blocks_pkey';
const MAX_CAUSE_DEPTH = 3;

/** Walks the `cause` chain looking for a unique violation on the block
 * primary key. */
function isBlockPrimaryKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code: unknown = Reflect.get(current, 'code');
    if (code === UNIQUE_VIOLATION) {
      const constraint: unknown = Reflect.get(current, 'constraint_name');
      return constraint === BLOCK_PRIMARY_KEY_CONSTRAINT;
    }
    current = current.cause;
  }
  return false;
}

/** What the batch refers to before it writes anything. */
type BatchScan = {
  /** Existing blocks the operations name: not created earlier in the
   * batch, so they must exist and belong to the page. */
  readonly externalIds: ReadonlySet<string>;
  /** Every id an insert supplies, subtrees included. */
  readonly suppliedIds: ReadonlySet<string>;
};

function referencedIds(op: BlockEditOp): readonly string[] {
  const ids: string[] = [];
  if (op.op !== 'insert') ids.push(op.blockId);
  if (op.op === 'insert' || op.op === 'move') {
    const { parentId, previousSiblingId, nextSiblingId } = op.position;
    for (const id of [parentId, previousSiblingId, nextSiblingId]) {
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

/**
 * The checks that need no database: the limits, the shape of every id, and
 * which ids the batch refers to. An id naming an existing block that is not
 * a uuid cannot exist (`BlockNotFoundError`); an id an insert supplies that
 * is not a canonical lowercase uuid is a caller error (`TypeError`), and one
 * supplied twice in the batch is a conflict.
 */
function scanBatch(input: BlockEditInput): BatchScan {
  if (input.ops.length === 0) throw new BlockEditLimitError('empty');
  if (input.ops.length > BLOCK_EDIT_MAX_OPS) {
    throw new BlockEditLimitError('ops');
  }

  const externalIds = new Set<string>();
  const suppliedIds = new Set<string>();
  let nodeCount = 0;
  for (const op of input.ops) {
    for (const id of referencedIds(op)) {
      if (!UUID_PATTERN.test(id)) throw new BlockNotFoundError(id);
      if (!suppliedIds.has(id)) externalIds.add(id);
    }
    if (op.op !== 'insert') continue;

    const pending: BlockEditNode[] = [op.node];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      nodeCount += 1;
      if (nodeCount > BLOCK_EDIT_MAX_NODES) {
        throw new BlockEditLimitError('nodes');
      }
      if (node.id !== undefined) {
        if (!UUID_PATTERN.test(node.id)) {
          throw new TypeError(
            '@plakboek/pages: a supplied block id must be a lowercase uuid',
          );
        }
        if (suppliedIds.has(node.id)) throw new BlockIdConflictError(node.id);
        suppliedIds.add(node.id);
      }
      pending.push(...(node.children ?? []));
    }
  }
  return { externalIds, suppliedIds };
}

/** Refuses the batch unless every existing block it names belongs to the
 * page (research Pattern 5), and no id an insert supplies is taken. One
 * query for both. */
async function verifyReferences(
  tx: AuditTransaction,
  page: PageRecord,
  scan: BatchScan,
): Promise<void> {
  const ids = [...new Set([...scan.externalIds, ...scan.suppliedIds])];
  if (ids.length === 0) return;
  const rows = await tx
    .select({
      id: pageBlocks.id,
      ownerType: pageBlocks.ownerType,
      ownerId: pageBlocks.ownerId,
      locale: pageBlocks.locale,
    })
    .from(pageBlocks)
    .where(inArray(pageBlocks.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of scan.externalIds) {
    const row = byId.get(id);
    if (row === undefined) throw new BlockNotFoundError(id);
    if (
      row.ownerType !== 'page' ||
      row.ownerId !== page.id ||
      row.locale !== page.locale
    ) {
      throw new BlockOwnershipError(id);
    }
  }
  for (const id of scan.suppliedIds) {
    if (byId.has(id)) throw new BlockIdConflictError(id);
  }
}

/** What the batch has done so far. */
type BatchState = {
  readonly createdIds: string[];
  readonly deletedIds: Set<string>;
  readonly updatedIds: Set<string>;
  readonly movedIds: Set<string>;
  readonly touchedParentIds: Set<string | null>;
  /** The version each touched block was checked against the first time an
   * operation of this batch touched it. */
  readonly firstBaseVersions: Map<string, number>;
};

function refuseDeletedReferences(state: BatchState, op: BlockEditOp): void {
  for (const id of referencedIds(op)) {
    if (state.deletedIds.has(id)) throw new BlockNotFoundError(id);
  }
}

/** Loads and locks a block an operation names and checks its version. A
 * block an earlier operation of this batch already checked and bumped is
 * checked against that first version instead of the stored one: the client
 * built the whole batch from one snapshot and cannot know about the bumps
 * its own operations cause. */
async function touchBlock(
  tx: AuditTransaction,
  state: BatchState,
  blockId: string,
  baseVersion: number,
): ReturnType<typeof loadBlockForUpdate> {
  const first = state.firstBaseVersions.get(blockId);
  if (first === undefined) {
    const current = await loadBlockForUpdate(tx, blockId, baseVersion);
    state.firstBaseVersions.set(blockId, baseVersion);
    return current;
  }
  if (baseVersion !== first) {
    throw new StaleBlockVersionError(blockId, baseVersion, first);
  }
  return await loadBlockForUpdate(tx, blockId, null);
}

async function insertNode(
  tx: AuditTransaction,
  ctx: WriteContext,
  state: BatchState,
  node: BlockEditNode,
  parentBlockId: string | null,
  previousSiblingId: string | null | undefined,
  nextSiblingId: string | null | undefined,
): Promise<void> {
  let created: Awaited<ReturnType<typeof insertBlockInTransaction>>;
  try {
    created = await insertBlockInTransaction(tx, ctx, {
      ...(node.id === undefined ? {} : { id: node.id }),
      blockType: node.type,
      parentBlockId,
      ...(node.props === undefined ? {} : { props: node.props }),
      ...(node.layout === undefined ? {} : { layout: node.layout }),
      previousSiblingId,
      nextSiblingId,
    });
  } catch (error) {
    // Backstop for a block created by a concurrent transaction between the
    // up-front check and this insert.
    if (node.id !== undefined && isBlockPrimaryKeyViolation(error)) {
      throw new BlockIdConflictError(node.id);
    }
    throw error;
  }
  state.createdIds.push(created.id);
  for (const child of node.children ?? []) {
    await insertNode(tx, ctx, state, child, created.id, undefined, undefined);
  }
}

async function applyOperation(
  tx: AuditTransaction,
  ctx: WriteContext,
  state: BatchState,
  op: BlockEditOp,
): Promise<void> {
  refuseDeletedReferences(state, op);
  switch (op.op) {
    case 'insert': {
      await insertNode(
        tx,
        ctx,
        state,
        op.node,
        op.position.parentId,
        op.position.previousSiblingId,
        op.position.nextSiblingId,
      );
      state.touchedParentIds.add(op.position.parentId);
      return;
    }
    case 'update': {
      const current = await touchBlock(tx, state, op.blockId, op.baseVersion);
      await updateBlockInTransaction(tx, ctx, {
        current,
        ...(op.props === undefined ? {} : { props: op.props }),
        ...(op.layout === undefined ? {} : { layout: op.layout }),
      });
      state.updatedIds.add(op.blockId);
      return;
    }
    case 'move': {
      const current = await touchBlock(tx, state, op.blockId, op.baseVersion);
      await moveBlockInTransaction(tx, ctx, {
        current,
        newParentBlockId: op.position.parentId,
        previousSiblingId: op.position.previousSiblingId,
        nextSiblingId: op.position.nextSiblingId,
      });
      state.movedIds.add(op.blockId);
      state.touchedParentIds.add(current.parentBlockId);
      state.touchedParentIds.add(op.position.parentId);
      return;
    }
    case 'delete': {
      const current = await touchBlock(tx, state, op.blockId, op.baseVersion);
      const { rows } = await deleteSubtreeInTransaction(tx, ctx, { current });
      for (const row of rows) state.deletedIds.add(row.id);
      state.touchedParentIds.add(current.parentBlockId);
      return;
    }
  }
}

/**
 * Applies a batch of block operations to one page atomically. Refuses an
 * empty batch, more than `BLOCK_EDIT_MAX_OPS` operations or more than
 * `BLOCK_EDIT_MAX_NODES` inserted blocks before any query, and a batch
 * holding a delete when the actor lacks `pages:delete` (recorded through
 * `recordDenied`, nothing written). Then, through `deps.recorder.run`
 * (`pages:edit` / `block.edit`, one audit row for the whole batch carrying
 * the batch id and the per-kind counts): loads and locks
 * the page `FOR UPDATE`, throwing `StalePageVersionError` when its version
 * is not `basePageVersion`; checks the page lock once; checks that every
 * existing block the batch names belongs to the page and that no supplied
 * id is taken; then applies the operations in order through the same
 * transactional bodies the single-operation functions use, all under one
 * `revisionBatchId`; bumps the page version once and prunes revisions once.
 * Any refusal rolls everything back.
 *
 * Property writes accept empty required values (D-21); layout is validated
 * against the column presets (D-33). Placement is checked per block exactly
 * as an insert, a move or a delete would be on its own. A delete records a
 * delete revision, props and layout included, for every block of the
 * removed subtree before the rows go; an operation naming a block an
 * earlier operation of the batch deleted is `BlockNotFoundError`.
 */
export async function applyBlockEdit(
  deps: PagesDeps,
  actor: AuditActor,
  input: BlockEditInput,
): Promise<BlockEditResult> {
  const scan = scanBatch(input);

  // Removing content is a stronger act than editing it: a batch holding a
  // delete needs `pages:delete` on top of the `pages:edit` the run below
  // checks. Resolved up front, so a refusal writes only its denied audit row
  // and no transaction ever opens (research Pitfall 10).
  if (
    input.ops.some((op) => op.op === 'delete') &&
    !deps.resolver
      .resolve(actor.roleKey, { userId: actor.userId })
      .has('pages:delete')
  ) {
    await deps.recorder.recordDenied(actor, {
      permission: 'pages:delete',
      action: 'block.edit',
      entityType: 'page',
      entityId: input.pageId,
    });
    throw new PermissionDeniedError('pages:delete', actor.roleKey);
  }

  const now = deps.now ?? (() => new Date());
  // Read once, before the transaction opens, like every other write path.
  const revisionCap = await getRevisionCap(deps.db);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'block.edit',
      entityType: 'page',
      entityId: input.pageId,
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
      await verifyReferences(tx, page, scan);

      const ownerRef: OwnerRef = {
        ownerType: 'page',
        ownerId: page.id,
        locale: page.locale,
      };
      const ctx: WriteContext = {
        deps,
        actor,
        page,
        ownerRef,
        revisionBatchId: newRevisionBatchId(),
        now: now(),
      };
      const state: BatchState = {
        createdIds: [],
        deletedIds: new Set(),
        updatedIds: new Set(),
        movedIds: new Set(),
        touchedParentIds: new Set(),
        firstBaseVersions: new Map(),
      };
      for (const op of input.ops) {
        await applyOperation(tx, ctx, state, op);
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

      const result: BlockEditResult = {
        pageVersion: page.version + 1,
        revisionBatchId: ctx.revisionBatchId,
        createdIds: Object.freeze([...state.createdIds]),
        deletedIds: Object.freeze([...state.deletedIds]),
        updatedIds: Object.freeze([...state.updatedIds]),
        movedIds: Object.freeze([...state.movedIds]),
        touchedParentIds: Object.freeze([...state.touchedParentIds]),
      };
      return {
        result,
        after: {
          revisionBatchId: ctx.revisionBatchId,
          counts: {
            insert: result.createdIds.length,
            update: result.updatedIds.length,
            move: result.movedIds.length,
            delete: result.deletedIds.length,
          },
        },
      };
    },
  );
}
