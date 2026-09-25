/**
 * Per-block revision writer (D-26, D-27), batch rollup reads, per-page cap
 * pruning, restore preview and audited restore (D-28, D-29, D-13, mirrors
 * `@plakboek/content`'s D-17 restore shape). Mirrors `@plakboek/content`'s
 * `recordRevision` insert-and-return shape for the writer. This module
 * defines no update for `block_revisions` -- once written, a revision row is
 * only ever read, pruned by `pruneBlockRevisions`, or (`restoreRevisionBatch`)
 * superseded by a fresh revision batch describing the restore -- never
 * updated in place.
 */
import { randomUUID } from 'node:crypto';
import type { AuditDatabase, AuditTransaction } from '@plakboek/auth';
import { asc, eq, sql } from 'drizzle-orm';
import { blockRevisions } from './schema.js';
import {
  BLOCK_CHANGE_TYPES,
  BLOCK_REVISION_KINDS,
  type BlockChangeType,
  type BlockRevisionKind,
  type OwnerRef,
} from './types.js';

export type RecordBlockRevisionInput = {
  readonly blockId: string;
  readonly owner: OwnerRef;
  readonly revisionBatchId: string;
  readonly changeType: BlockChangeType;
  readonly kind: BlockRevisionKind;
  readonly blockType: string;
  readonly parentBlockId: string | null;
  readonly sortOrder: number;
  readonly depth: number;
  readonly props: unknown;
  readonly schemaVersion: number;
  readonly authorId: string | null;
  readonly createdAt: Date;
};

/** Generates one revision-batch id, shared by every `recordBlockRevision`
 * call a single save/publish makes (D-26) -- "what changed in this edit"
 * is then one query on `revision_batch_id`. */
export function newRevisionBatchId(): string {
  return randomUUID();
}

/**
 * Inserts one immutable `block_revisions` row through `deps.recorder.run`'s
 * transaction and returns its id, throwing when the insert returns no row.
 * `props` are stored raw, exactly as submitted, with the row's own
 * `schemaVersion` (D-13) -- never upcast at write time; upcasting only
 * ever runs on read (D-11).
 */
export async function recordBlockRevision(
  tx: AuditTransaction,
  input: RecordBlockRevisionInput,
): Promise<string> {
  const [row] = await tx
    .insert(blockRevisions)
    .values({
      blockId: input.blockId,
      ownerType: input.owner.ownerType,
      ownerId: input.owner.ownerId,
      locale: input.owner.locale,
      revisionBatchId: input.revisionBatchId,
      changeType: input.changeType,
      kind: input.kind,
      blockType: input.blockType,
      parentBlockId: input.parentBlockId,
      sortOrder: input.sortOrder,
      depth: input.depth,
      props: input.props,
      schemaVersion: input.schemaVersion,
      authorId: input.authorId,
      createdAt: input.createdAt,
    })
    .returning({ id: blockRevisions.id });
  if (row === undefined) {
    throw new Error('@plakboek/pages: block revision insert returned no row');
  }
  return row.id;
}

// -- Batch rollup reads (D-29) -----------------------------------------------

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. Mirrors
 * `tree.ts`'s helper of the same shape. */
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

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(
      `@plakboek/pages: expected column "${field}" to be a number`,
    );
  }
  return value;
}

/** A raw `execute()` result reports a `timestamptz` column as a `Date`
 * instance on some drivers and as an ISO string on others. Mirrors
 * `tree.ts`'s `asDate` helper. */
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

function isBlockChangeType(value: string): value is BlockChangeType {
  return BLOCK_CHANGE_TYPES.some((type) => type === value);
}

function asBlockChangeType(value: unknown): BlockChangeType {
  if (typeof value === 'string' && isBlockChangeType(value)) {
    return value;
  }
  throw new TypeError(
    `@plakboek/pages: unexpected change_type "${String(value)}" stored for a block revision`,
  );
}

function isBlockRevisionKind(value: string): value is BlockRevisionKind {
  return BLOCK_REVISION_KINDS.some((kind) => kind === value);
}

function asBlockRevisionKind(value: unknown): BlockRevisionKind {
  if (typeof value === 'string' && isBlockRevisionKind(value)) {
    return value;
  }
  throw new TypeError(
    `@plakboek/pages: unexpected kind "${String(value)}" stored for a block revision`,
  );
}

function asStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `@plakboek/pages: expected column "${field}" to be an array`,
    );
  }
  return value.map((item, index) => asString(item, `${field}[${index}]`));
}

export type RevisionBatchSummary = {
  readonly revisionBatchId: string;
  readonly createdAt: Date;
  readonly authorId: string | null;
  readonly blockCount: number;
  readonly changeTypes: readonly BlockChangeType[];
  readonly kind: BlockRevisionKind;
};

export type ListPageRevisionBatchesInput = {
  readonly pageId: string;
  readonly locale: string;
  readonly limit?: number;
};

const DEFAULT_BATCH_LIST_LIMIT = 50;

/**
 * Rolls a page's `block_revisions` up to one row per `revision_batch_id`
 * (D-29's whole implementation -- page history *is* this rollup, no second
 * aggregation table): newest first, each row carrying the batch's shared
 * `kind` ('save' revisions never mix with 'publish' ones in the same batch,
 * since every write path stamps a batch with one fixed `kind`), how many
 * block revisions it holds and the distinct `change_type`s among them. A
 * batch whose blocks have since been deleted still lists here -- this reads
 * `block_revisions` only, never `page_blocks`, so a null `block_id` (D-27's
 * `ON DELETE SET NULL`) never drops a row from this rollup. Not
 * permission-gated: reads are internal API, gated by later phases'
 * HTTP/admin layers (mirrors `@plakboek/content`'s `listRevisions`).
 */
export async function listPageRevisionBatches(
  db: AuditDatabase,
  input: ListPageRevisionBatchesInput,
): Promise<readonly RevisionBatchSummary[]> {
  const limit = input.limit ?? DEFAULT_BATCH_LIST_LIMIT;
  const result: unknown = await db.execute(sql`
    SELECT
      revision_batch_id AS "revisionBatchId",
      min(created_at) AS "createdAt",
      min(author_id) AS "authorId",
      min(kind) AS "kind",
      count(*)::int AS "blockCount",
      array_agg(DISTINCT change_type) AS "changeTypes"
    FROM block_revisions
    WHERE owner_type = 'page'
      AND owner_id = ${input.pageId}
      AND locale = ${input.locale}
    GROUP BY revision_batch_id
    ORDER BY min(created_at) DESC, revision_batch_id DESC
    LIMIT ${limit}
  `);
  return resultRows(result).map((row) => ({
    revisionBatchId: asString(row.revisionBatchId, 'revisionBatchId'),
    createdAt: asDate(row.createdAt, 'createdAt'),
    authorId:
      typeof row.authorId === 'string'
        ? row.authorId
        : row.authorId === null
          ? null
          : (() => {
              throw new TypeError(
                '@plakboek/pages: expected column "authorId" to be a string or null',
              );
            })(),
    blockCount: asNumber(row.blockCount, 'blockCount'),
    changeTypes: Object.freeze(
      asStringArray(row.changeTypes, 'changeTypes').map(asBlockChangeType),
    ),
    kind: asBlockRevisionKind(row.kind),
  }));
}

export type BlockRevisionSummary = {
  readonly id: string;
  readonly blockId: string | null;
  readonly blockType: string;
  readonly changeType: BlockChangeType;
  readonly kind: BlockRevisionKind;
  readonly parentBlockId: string | null;
  readonly sortOrder: number;
  readonly depth: number;
  readonly props: unknown;
  readonly schemaVersion: number;
  readonly authorId: string | null;
  readonly createdAt: Date;
};

type BatchRevisionRow = typeof blockRevisions.$inferSelect;

/** Loads every `block_revisions` row sharing `revisionBatchId`, ordered
 * `created_at, id` -- shared by `listBatchRevisions` (the public, narrower
 * summary shape) and `computeBlockRestorePreview`/`restoreRevisionBatch`
 * (which also need `ownerType`/`ownerId`/`locale`, absent from
 * `BlockRevisionSummary`), so both read the same rows through one query
 * shape rather than two independent ones. */
async function loadBatchRevisionRows(
  db: AuditDatabase,
  revisionBatchId: string,
): Promise<readonly BatchRevisionRow[]> {
  return await db
    .select()
    .from(blockRevisions)
    .where(eq(blockRevisions.revisionBatchId, revisionBatchId))
    .orderBy(asc(blockRevisions.createdAt), asc(blockRevisions.id));
}

/**
 * Expands one batch into its block revisions, ordered `created_at, id`,
 * `props` returned raw exactly as stored (D-13) -- no upcasting on a history
 * read; upcasting is a restore-time-only concern
 * (`computeBlockRestorePreview`/`restoreRevisionBatch`, below). Not
 * permission-gated (see `listPageRevisionBatches`).
 */
export async function listBatchRevisions(
  db: AuditDatabase,
  input: { readonly revisionBatchId: string },
): Promise<readonly BlockRevisionSummary[]> {
  const rows = await loadBatchRevisionRows(db, input.revisionBatchId);
  return rows.map((row) => ({
    id: row.id,
    blockId: row.blockId,
    blockType: row.blockType,
    changeType: asBlockChangeType(row.changeType),
    kind: asBlockRevisionKind(row.kind),
    parentBlockId: row.parentBlockId,
    sortOrder: row.sortOrder,
    depth: row.depth,
    props: row.props,
    schemaVersion: row.schemaVersion,
    authorId: row.authorId,
    createdAt: row.createdAt,
  }));
}

// -- Per-page cap pruning (D-28) ---------------------------------------------

/** Reads an affected-row count from a raw `execute()` result across
 * drivers: postgres-js reports `count`, node-postgres reports `rowCount`.
 * Mirrors `pages.ts`'s/`@plakboek/content`'s helper of the same shape. */
function affectedRowCount(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    for (const property of ['count', 'rowCount']) {
      const value: unknown = Reflect.get(result, property);
      if (typeof value === 'number') return value;
    }
  }
  throw new TypeError(
    '@plakboek/pages: could not read the affected row count from the database driver',
  );
}

export type PruneBlockRevisionsInput = {
  readonly pageId: string;
  readonly locale: string;
  readonly cap: number;
};

/**
 * Deletes `save`-kind revision batches ranked beyond `cap` for one page,
 * counted per PAGE in BATCHES (D-26, D-28) -- never per block, never per
 * individual revision row: a 40-block page saved once still counts as one
 * batch. Batches are dense-ranked newest-first by their own minimum
 * `created_at` (ties -- every row in one batch shares the identical
 * `created_at`, see `recordBlockRevision`'s callers -- collapse to one rank);
 * every row of a batch ranked beyond `cap` is deleted together. Rows where
 * `kind = 'publish'` are excluded from the ranking entirely (the inner
 * grouped query only ever considers `kind = 'save'` batches), so a publish
 * batch is never counted against the cap and never removed, regardless of
 * its age.
 * A revision row named as a VALUE anywhere in any of this page's
 * `page_publications.revision_manifest` (`{ [blockId]: revisionId }`, so the
 * check walks each manifest's values, not its keys) is excluded from the
 * delete even when its batch's rank exceeds `cap` -- a revision a live
 * publication still points to is never pruned out from under it.
 * `cap <= 0` (uncapped) is a no-op returning `0` without running a
 * statement. Scoped to one `(pageId, locale)` pair: pruning one page's
 * history never touches another page's rows, or another locale's rows of
 * the same page's translation group. Returns the number of `block_revisions`
 * rows deleted, read through the same driver-agnostic `affectedRowCount`
 * helper `@plakboek/content`'s `pruneSaveRevisions` uses (mirrors that
 * function's ranked-CTE-delete shape one level up: batches instead of rows).
 */
export async function pruneBlockRevisions(
  tx: AuditTransaction,
  input: PruneBlockRevisionsInput,
): Promise<number> {
  if (input.cap <= 0) return 0;

  const result: unknown = await tx.execute(sql`
    WITH ranked AS (
      SELECT revision_batch_id,
        dense_rank() OVER (ORDER BY min_created DESC) AS rn
      FROM (
        SELECT revision_batch_id, min(created_at) AS min_created
        FROM block_revisions
        WHERE owner_type = 'page'
          AND owner_id = ${input.pageId}
          AND locale = ${input.locale}
          AND kind = 'save'
        GROUP BY revision_batch_id
      ) batches
    )
    DELETE FROM block_revisions
    WHERE owner_type = 'page'
      AND owner_id = ${input.pageId}
      AND locale = ${input.locale}
      AND revision_batch_id IN (
        SELECT revision_batch_id FROM ranked WHERE rn > ${input.cap}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM page_publications pp
        CROSS JOIN LATERAL jsonb_each_text(pp.revision_manifest)
          AS manifest_entry(manifest_block_id, manifest_revision_id)
        WHERE pp.page_id = ${input.pageId}
          AND manifest_entry.manifest_revision_id = block_revisions.id::text
      )
  `);
  return affectedRowCount(result);
}
