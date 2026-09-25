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
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PagesDeps, PagesHooks } from './config.js';
import { loadPageForUpdate, StalePageVersionError } from './pages.js';
import { assertPlacementAllowed, countAncestorSections } from './placement.js';
import {
  getBlockDefinition,
  validateBlockProps,
  type BlockDefinition,
} from './registry.js';
import { newRevisionBatchId, recordBlockRevision } from './revisions.js';
import { pageBlocks, pages } from './schema.js';
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
        sortOrder = (siblingMax?.max ?? 0) + 1000;
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

      return { result: record, after: record };
    },
  );
}
