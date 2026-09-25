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
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { getFieldTypeDefinition } from '@plakboek/content';
import { asc, eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { loadPageForUpdate, StalePageVersionError } from './pages.js';
import { assertPlacementAllowed, countAncestorSections } from './placement.js';
import {
  BlockPropsValidationError,
  getBlockDefinition,
  resolveBlockProperties,
  validateBlockProps,
  type BlockDefinition,
} from './registry.js';
import { blockRevisions, pageBlocks, pages } from './schema.js';
import {
  BLOCK_CHANGE_TYPES,
  BLOCK_REVISION_KINDS,
  type BlockChangeType,
  type BlockRevisionKind,
  type OwnerRef,
} from './types.js';
import { upcastOnRead, type DegradedReason } from './versioning.js';

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
 * Inserts one immutable `block_revisions` row through the caller's own
 * already-open audited transaction and returns its id, throwing when the
 * insert returns no row.
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

// -- Restore preview and audited apply (D-13, mirrors @plakboek/content's ---
// -- D-17 restore shape) -----------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Thrown by `computeBlockRestorePreview`/`restoreRevisionBatch` when
 * `revisionBatchId` names no rows in `block_revisions`. */
export class RevisionBatchNotFoundError extends Error {
  readonly revisionBatchId: string;

  constructor(revisionBatchId: string) {
    super(
      `@plakboek/pages: no revision batch found for id "${revisionBatchId}"`,
    );
    this.name = 'RevisionBatchNotFoundError';
    this.revisionBatchId = revisionBatchId;
  }
}

/** Thrown by `restoreRevisionBatch` when the recomputed preview reports any
 * block-level degradation (an unregistered block type, a stored version with
 * no upcaster path to the current one) or any property classified `failed` --
 * refused before anything is written, naming every offending block. */
export class DegradedRestoreError extends Error {
  readonly blocks: readonly {
    readonly revisionId: string;
    readonly blockId: string | null;
    readonly blockType: string;
  }[];

  constructor(offending: readonly RestoreBlockPreview[]) {
    const names = offending.map(
      (block) => `"${block.blockType}" (revision ${block.revisionId})`,
    );
    super(
      `@plakboek/pages: cannot restore -- the following block(s) cannot reach the current schema cleanly: ${names.join(', ')}`,
    );
    this.name = 'DegradedRestoreError';
    this.blocks = Object.freeze(
      offending.map((block) => ({
        revisionId: block.revisionId,
        blockId: block.blockId,
        blockType: block.blockType,
      })),
    );
  }
}

/** Thrown by `restoreRevisionBatch` when a `'move'`, `'create'` or
 * `'update'` revision's block no longer exists to restore onto -- distinct
 * from `tree.ts`'s `BlockNotFoundError`: `tree.ts` already imports this
 * module's revision writer, so importing back from `tree.ts` here would
 * create a circular import. */
export class RestoreTargetNotFoundError extends Error {
  readonly revisionId: string;
  readonly blockId: string;

  constructor(revisionId: string, blockId: string) {
    super(
      `@plakboek/pages: cannot restore revision "${revisionId}" -- its block "${blockId}" no longer exists`,
    );
    this.name = 'RestoreTargetNotFoundError';
    this.revisionId = revisionId;
    this.blockId = blockId;
  }
}

export type RestorePropertyOutcome = {
  readonly propertyKey: string;
  readonly status: 'mapped' | 'defaulted' | 'dropped' | 'failed';
  readonly value?: unknown;
  readonly detail?: string;
};

export type RestoreBlockPreview = {
  readonly revisionId: string;
  readonly blockId: string | null;
  readonly blockType: string;
  readonly changeType: BlockChangeType;
  readonly storedVersion: number;
  readonly currentVersion: number | null;
  readonly degradedReason?: DegradedReason;
  readonly properties: readonly RestorePropertyOutcome[];
};

export type RestoreBatchPreview = {
  readonly revisionBatchId: string;
  readonly pageId: string;
  readonly locale: string;
  readonly blocks: readonly RestoreBlockPreview[];
  readonly mappedCount: number;
  readonly defaultedCount: number;
  readonly droppedCount: number;
  readonly failedCount: number;
};

/** Classifies one non-degraded block's upcast props against its CURRENT
 * declaration (D-17's shape applied to a block): every resolved property is
 * `mapped` (present and valid), `defaulted` (absent, the declaration
 * supplies a `defaultValue`), or `failed` (absent with no default, or
 * present but invalid); a key present in the upcast props but no longer
 * declared is `dropped`. Appends onto `properties`/the running counts
 * rather than returning a fresh structure, mirroring how the caller
 * accumulates across every block in the batch. */
function classifyBlockProperties(
  definition: BlockDefinition,
  upcastProps: Record<string, unknown>,
  properties: RestorePropertyOutcome[],
  counts: {
    mapped: number;
    defaulted: number;
    dropped: number;
    failed: number;
  },
): void {
  const resolved = resolveBlockProperties(definition);
  const seenKeys = new Set<string>();

  for (const [propertyKey, property] of Object.entries(resolved)) {
    seenKeys.add(propertyKey);
    const fieldDefinition = getFieldTypeDefinition(property.fieldType);
    const rawValue: unknown = upcastProps[propertyKey];
    const isAbsent = fieldDefinition.isEmptyValue(rawValue);

    if (isAbsent) {
      if (property.defaultValue !== undefined) {
        properties.push({
          propertyKey,
          status: 'defaulted',
          value: property.defaultValue,
        });
        counts.defaulted += 1;
      } else if (property.required === true) {
        properties.push({
          propertyKey,
          status: 'failed',
          detail: 'required, absent from the revision and no default value',
        });
        counts.failed += 1;
      } else {
        properties.push({ propertyKey, status: 'mapped' });
        counts.mapped += 1;
      }
      continue;
    }

    const optionsResult = fieldDefinition.optionsSchema.safeParse(
      property.options ?? {},
    );
    const options = optionsResult.success
      ? optionsResult.data
      : (property.options ?? {});
    const result = fieldDefinition
      .buildValueSchema(options)
      .safeParse(rawValue);
    if (!result.success) {
      properties.push({
        propertyKey,
        status: 'failed',
        detail: 'value in the revision fails the current field type',
      });
      counts.failed += 1;
      continue;
    }
    properties.push({ propertyKey, status: 'mapped', value: result.data });
    counts.mapped += 1;
  }

  for (const key of Object.keys(upcastProps)) {
    if (!seenKeys.has(key)) {
      properties.push({ propertyKey: key, status: 'dropped', detail: key });
      counts.dropped += 1;
    }
  }
}

export type ComputeBlockRestorePreviewInput = {
  readonly revisionBatchId: string;
};

/**
 * Previews restoring `revisionBatchId` onto the current schema (D-13, mirrors
 * `@plakboek/content`'s D-17 `computeRestorePreview`), without writing
 * anything. Read-only, and typed to accept a transaction handle too, so
 * `restoreRevisionBatch` recomputes this same preview inside its own
 * transaction rather than trusting a caller's earlier read. Throws
 * `RevisionBatchNotFoundError` for a batch id naming no rows. For each
 * revision in the batch, in `created_at, id` order: a `block_type` absent
 * from the registry degrades the block `unknown-block-type` (`currentVersion:
 * null`) and marks every key present in its stored `props` `failed`;
 * otherwise `upcastOnRead` (D-11) resolves the stored `props` against the
 * registry's current shape -- a degraded outcome marks the block with that
 * `DegradedReason` and, again, every present key `failed`; a clean upcast is
 * classified property-by-property (`classifyBlockProperties`) against the
 * CURRENT declaration. **Upcasting happens here, on the way out -- never
 * against the stored row.** This module contains no update statement against
 * `block_revisions`: a history read, and a preview, never rewrite it.
 */
export async function computeBlockRestorePreview(
  db: AuditDatabase,
  input: ComputeBlockRestorePreviewInput,
): Promise<RestoreBatchPreview> {
  const [firstRow, ...restRows] = await loadBatchRevisionRows(
    db,
    input.revisionBatchId,
  );
  if (firstRow === undefined) {
    throw new RevisionBatchNotFoundError(input.revisionBatchId);
  }
  const rows = [firstRow, ...restRows];
  const pageId = firstRow.ownerId;
  const locale = firstRow.locale;

  const blocks: RestoreBlockPreview[] = [];
  const counts = { mapped: 0, defaulted: 0, dropped: 0, failed: 0 };

  for (const row of rows) {
    let definition: BlockDefinition | undefined;
    try {
      definition = getBlockDefinition(row.blockType);
    } catch {
      definition = undefined;
    }

    if (definition === undefined) {
      const storedProps = isPlainObject(row.props) ? row.props : {};
      const properties: RestorePropertyOutcome[] = Object.keys(storedProps).map(
        (propertyKey) => ({ propertyKey, status: 'failed' as const }),
      );
      counts.failed += properties.length;
      blocks.push({
        revisionId: row.id,
        blockId: row.blockId,
        blockType: row.blockType,
        changeType: asBlockChangeType(row.changeType),
        storedVersion: row.schemaVersion,
        currentVersion: null,
        degradedReason: 'unknown-block-type',
        properties: Object.freeze(properties),
      });
      continue;
    }

    const outcome = upcastOnRead(definition, row.schemaVersion, row.props);
    if (outcome.degraded) {
      const storedProps = isPlainObject(row.props) ? row.props : {};
      const properties: RestorePropertyOutcome[] = Object.keys(storedProps).map(
        (propertyKey) => ({ propertyKey, status: 'failed' as const }),
      );
      counts.failed += properties.length;
      blocks.push({
        revisionId: row.id,
        blockId: row.blockId,
        blockType: row.blockType,
        changeType: asBlockChangeType(row.changeType),
        storedVersion: row.schemaVersion,
        currentVersion: definition.schemaVersion,
        degradedReason: outcome.reason,
        properties: Object.freeze(properties),
      });
      continue;
    }

    const upcastProps = isPlainObject(outcome.props) ? outcome.props : {};
    const properties: RestorePropertyOutcome[] = [];
    classifyBlockProperties(definition, upcastProps, properties, counts);
    blocks.push({
      revisionId: row.id,
      blockId: row.blockId,
      blockType: row.blockType,
      changeType: asBlockChangeType(row.changeType),
      storedVersion: row.schemaVersion,
      currentVersion: definition.schemaVersion,
      properties: Object.freeze(properties),
    });
  }

  return Object.freeze({
    revisionBatchId: input.revisionBatchId,
    pageId,
    locale,
    blocks: Object.freeze(blocks),
    mappedCount: counts.mapped,
    defaultedCount: counts.defaulted,
    droppedCount: counts.dropped,
    failedCount: counts.failed,
  });
}

/** Builds the props a restore actually writes for one block: every `mapped`
 * or `defaulted` outcome carrying a `value` contributes it under its own
 * key; a `mapped` outcome with no `value` (an optional property absent from
 * both the revision and the current declaration) and every `dropped` key
 * contribute nothing. `restoreRevisionBatch` only ever calls this after
 * confirming the block carries no `failed` outcome. */
function buildRestoredProps(
  properties: readonly RestorePropertyOutcome[],
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const property of properties) {
    if (
      (property.status === 'mapped' || property.status === 'defaulted') &&
      Object.hasOwn(property, 'value')
    ) {
      props[property.propertyKey] = property.value;
    }
  }
  return props;
}

export type RestoreRevisionBatchInput = {
  readonly revisionBatchId: string;
  readonly pageId: string;
  readonly basePageVersion: number;
};

export type RestoreBatchResult = {
  readonly revisionBatchId: string;
  readonly restoredBlocks: number;
};

/**
 * Restores a revision batch as one audited, version-checked,
 * placement-validated mutation (D-13, T-04-04, T-04-35, T-04-36), gated on
 * `pages:edit` / `page.restore-batch` through the recorder. Inside the
 * transaction: recomputes `computeBlockRestorePreview` (never trusting a
 * caller's earlier read) and refuses with `DegradedRestoreError` when any
 * block carries a `degradedReason` or any property is `failed`, naming
 * every offending block -- writing nothing. Then `loadPageForUpdate` and
 * throws `StalePageVersionError` on a base-version mismatch. Replays the
 * batch's blocks in `created_at, id` order, each restored to the CURRENT
 * schema's shape (`buildRestoredProps` off the already-computed preview):
 * a `'delete'` revision re-creates the block with a fresh id and its
 * recorded `parent_block_id`/`sort_order`/`depth`, stamped with the
 * registry's current `schemaVersion`; a `'move'` revision re-parents the
 * still-live block to its recorded position, leaving its props untouched;
 * a `'create'`/`'update'` revision rewrites the still-live block's props.
 * Before each write, builds the `PlacementContext` for the recorded
 * position and calls `assertPlacementAllowed`, so a restore can never
 * recreate a shape the current registry forbids; as one more write-time
 * safety net, `validateBlockProps` re-checks the built props (catching a
 * constraint this preview's own classification didn't model, e.g. a
 * property that became `fixed`/`narrowed` after the revision was
 * recorded) and refuses with `DegradedRestoreError` if it disagrees. Every
 * restored block records one fresh revision (`recordBlockRevision`)
 * sharing one new `revision_batch_id`, and the page's `version` is bumped
 * exactly once at the end -- a restore is itself inspectable and
 * reversible. No `block_revisions` row from the restored batch, or any
 * other, is ever updated.
 */
export async function restoreRevisionBatch(
  deps: PagesDeps,
  actor: AuditActor,
  input: RestoreRevisionBatchInput,
): Promise<RestoreBatchResult> {
  const now = deps.now ?? (() => new Date());
  const previewBefore = await computeBlockRestorePreview(deps.db, {
    revisionBatchId: input.revisionBatchId,
  });

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'page.restore-batch',
      entityType: 'page',
      entityId: input.pageId,
      before: {
        revisionBatchId: previewBefore.revisionBatchId,
        blockCount: previewBefore.blocks.length,
        mappedCount: previewBefore.mappedCount,
        defaultedCount: previewBefore.defaultedCount,
        droppedCount: previewBefore.droppedCount,
        failedCount: previewBefore.failedCount,
      },
    },
    async (tx) => {
      const preview = await computeBlockRestorePreview(tx, {
        revisionBatchId: input.revisionBatchId,
      });

      const offending = preview.blocks.filter(
        (block) =>
          block.degradedReason !== undefined ||
          block.properties.some((property) => property.status === 'failed'),
      );
      if (offending.length > 0) {
        throw new DegradedRestoreError(offending);
      }

      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.basePageVersion) {
        throw new StalePageVersionError(
          page.id,
          input.basePageVersion,
          page.version,
        );
      }

      const rawRows = await loadBatchRevisionRows(tx, input.revisionBatchId);
      const rawByRevisionId = new Map(rawRows.map((row) => [row.id, row]));
      const orderedBlocks = [...preview.blocks].sort((a, b) => {
        const depthA = rawByRevisionId.get(a.revisionId)?.depth ?? 0;
        const depthB = rawByRevisionId.get(b.revisionId)?.depth ?? 0;
        return depthA - depthB;
      });

      const ownerRef: OwnerRef = {
        ownerType: 'page',
        ownerId: page.id,
        locale: preview.locale,
      };
      const restoreBatchId = newRevisionBatchId();
      const restoredAt = now();
      let restoredBlocks = 0;

      for (const block of orderedBlocks) {
        const raw = rawByRevisionId.get(block.revisionId);
        if (raw === undefined) continue; // unreachable: preview is built from these exact rows
        const definition = getBlockDefinition(block.blockType);
        const restoredProps = buildRestoredProps(block.properties);

        let parentDefinition: BlockDefinition | null = null;
        let parentDepth: number | null = null;
        let parentSectionDepth = 0;
        if (raw.parentBlockId !== null) {
          const [parentRow] = await tx
            .select({
              depth: pageBlocks.depth,
              blockType: pageBlocks.blockType,
            })
            .from(pageBlocks)
            .where(eq(pageBlocks.id, raw.parentBlockId))
            .for('update');
          if (parentRow !== undefined) {
            parentDepth = parentRow.depth;
            parentDefinition = getBlockDefinition(parentRow.blockType);
            parentSectionDepth = await countAncestorSections(
              tx,
              raw.parentBlockId,
            );
          }
        }

        assertPlacementAllowed({
          owner: ownerRef,
          child: definition,
          parent: parentDefinition,
          parentDepth,
          parentSectionDepth,
          sectionNestingDepth: deps.config.sectionNestingDepth,
          blockDepthCeiling: deps.config.blockDepthCeiling,
        });

        if (block.changeType === 'delete') {
          let validatedProps: Record<string, unknown>;
          try {
            validatedProps = validateBlockProps(definition, restoredProps);
          } catch (error) {
            if (!(error instanceof BlockPropsValidationError)) throw error;
            throw new DegradedRestoreError([block]);
          }

          const newId = randomUUID();
          await tx.insert(pageBlocks).values({
            id: newId,
            ownerType: ownerRef.ownerType,
            ownerId: ownerRef.ownerId,
            locale: ownerRef.locale,
            parentBlockId: raw.parentBlockId,
            blockType: block.blockType,
            props: validatedProps,
            schemaVersion: definition.schemaVersion,
            depth: raw.depth,
            sortOrder: raw.sortOrder,
            version: 1,
            createdBy: actor.userId,
            updatedBy: actor.userId,
            createdAt: restoredAt,
            updatedAt: restoredAt,
          });

          await recordBlockRevision(tx, {
            blockId: newId,
            owner: ownerRef,
            revisionBatchId: restoreBatchId,
            changeType: 'create',
            kind: 'save',
            blockType: block.blockType,
            parentBlockId: raw.parentBlockId,
            sortOrder: raw.sortOrder,
            depth: raw.depth,
            props: validatedProps,
            schemaVersion: definition.schemaVersion,
            authorId: actor.userId,
            createdAt: restoredAt,
          });
          restoredBlocks += 1;
        } else if (block.changeType === 'move') {
          if (block.blockId === null) {
            throw new RestoreTargetNotFoundError(block.revisionId, '');
          }
          const [current] = await tx
            .select()
            .from(pageBlocks)
            .where(eq(pageBlocks.id, block.blockId))
            .for('update');
          if (current === undefined) {
            throw new RestoreTargetNotFoundError(
              block.revisionId,
              block.blockId,
            );
          }

          await tx
            .update(pageBlocks)
            .set({
              parentBlockId: raw.parentBlockId,
              sortOrder: raw.sortOrder,
              depth: raw.depth,
              version: sql`${pageBlocks.version} + 1`,
              updatedAt: restoredAt,
              updatedBy: actor.userId,
            })
            .where(eq(pageBlocks.id, block.blockId));

          await recordBlockRevision(tx, {
            blockId: current.id,
            owner: ownerRef,
            revisionBatchId: restoreBatchId,
            changeType: 'move',
            kind: 'save',
            blockType: current.blockType,
            parentBlockId: current.parentBlockId,
            sortOrder: current.sortOrder,
            depth: current.depth,
            props: current.props,
            schemaVersion: current.schemaVersion,
            authorId: actor.userId,
            createdAt: restoredAt,
          });
          restoredBlocks += 1;
        } else {
          if (block.blockId === null) {
            throw new RestoreTargetNotFoundError(block.revisionId, '');
          }
          let validatedProps: Record<string, unknown>;
          try {
            validatedProps = validateBlockProps(definition, restoredProps);
          } catch (error) {
            if (!(error instanceof BlockPropsValidationError)) throw error;
            throw new DegradedRestoreError([block]);
          }

          const [updated] = await tx
            .update(pageBlocks)
            .set({
              props: validatedProps,
              version: sql`${pageBlocks.version} + 1`,
              updatedAt: restoredAt,
              updatedBy: actor.userId,
            })
            .where(eq(pageBlocks.id, block.blockId))
            .returning();
          if (updated === undefined) {
            throw new RestoreTargetNotFoundError(
              block.revisionId,
              block.blockId,
            );
          }

          await recordBlockRevision(tx, {
            blockId: updated.id,
            owner: ownerRef,
            revisionBatchId: restoreBatchId,
            changeType: 'update',
            kind: 'save',
            blockType: updated.blockType,
            parentBlockId: updated.parentBlockId,
            sortOrder: updated.sortOrder,
            depth: updated.depth,
            props: updated.props,
            schemaVersion: updated.schemaVersion,
            authorId: actor.userId,
            createdAt: restoredAt,
          });
          restoredBlocks += 1;
        }
      }

      await tx
        .update(pages)
        .set({ version: sql`${pages.version} + 1` })
        .where(eq(pages.id, page.id));

      const result: RestoreBatchResult = {
        revisionBatchId: restoreBatchId,
        restoredBlocks,
      };
      return {
        result,
        after: { restoredBlocks, newBatchId: restoreBatchId },
      };
    },
  );
}
