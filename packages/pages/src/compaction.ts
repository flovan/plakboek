/**
 * Below-floor reporting and audited, batched, revision-recording
 * force-upcast-and-write-back for one block type (D-13, D-14, D-15).
 * `computeCompactionImpact` is the read-only preview half (mirrors
 * `@plakboek/content`'s `computeEntryPermanentDeleteImpact` /
 * `deleteEntryPermanently` impact-report-then-apply pair); `compactBlockType`
 * is the write, recomputing the same impact inside its own transaction so a
 * caller's earlier preview and the write can never disagree. Neither
 * function ever guesses which rows can be upgraded -- both read
 * `resolveUpcasterChain`'s own classification, the exact function
 * `upcastOnRead` itself uses.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import {
  checkBlockCompatibility,
  queryStoredVersionCounts,
  type BelowFloorEvent,
} from './compatibility.js';
import type { PagesDeps } from './config.js';
import { reportPagesWarning } from './config.js';
import {
  BlockPropsValidationError,
  getBlockDefinition,
  validateBlockProps,
} from './registry.js';
import { newRevisionBatchId, recordBlockRevision } from './revisions.js';
import { pageBlocks } from './schema.js';
import { OWNER_TYPES, type OwnerType } from './types.js';
import {
  createUpcastSession,
  resolveUpcasterChain,
  type DegradedReason,
} from './versioning.js';

const DEFAULT_COMPACTION_BATCH_SIZE = 500;

function isOwnerType(value: string): value is OwnerType {
  return OWNER_TYPES.some((type) => type === value);
}

function asOwnerType(value: string): OwnerType {
  if (isOwnerType(value)) return value;
  throw new TypeError(
    `@plakboek/pages: unexpected owner_type "${value}" stored for a block`,
  );
}

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

export type CompactionImpactEntry = {
  readonly version: number;
  readonly instanceCount: number;
  readonly upcastable: boolean;
};

export type CompactionImpact = {
  readonly blockKey: string;
  readonly currentVersion: number;
  readonly byStoredVersion: readonly CompactionImpactEntry[];
  readonly upcastableCount: number;
  readonly blockedCount: number;
};

/**
 * Reports, for one block type, exactly how many stored instances sit at
 * each stored `schema_version` that differs from the registry's current
 * one, and whether `resolveUpcasterChain` can bring each of those versions
 * to the current shape. Read-only: takes a database handle (or an open
 * transaction) and writes nothing.
 */
export async function computeCompactionImpact(
  db: AuditDatabase,
  blockKey: string,
): Promise<CompactionImpact> {
  const definition = getBlockDefinition(blockKey);
  const byBlockType = await queryStoredVersionCounts(db);
  const stored = byBlockType.get(blockKey) ?? [];

  const byStoredVersion: CompactionImpactEntry[] = stored
    .filter((entry) => entry.schemaVersion !== definition.schemaVersion)
    .map((entry) => ({
      version: entry.schemaVersion,
      instanceCount: entry.count,
      upcastable:
        resolveUpcasterChain(definition, entry.schemaVersion).kind !==
        'degraded',
    }))
    .sort((a, b) => a.version - b.version);

  let upcastableCount = 0;
  let blockedCount = 0;
  for (const entry of byStoredVersion) {
    if (entry.upcastable) upcastableCount += entry.instanceCount;
    else blockedCount += entry.instanceCount;
  }

  return Object.freeze({
    blockKey,
    currentVersion: definition.schemaVersion,
    byStoredVersion: Object.freeze(byStoredVersion),
    upcastableCount,
    blockedCount,
  });
}

export type CompactionSkippedEntry = {
  readonly blockId: string;
  readonly storedVersion: number;
  readonly reason: DegradedReason;
  readonly detail?: string;
};

export type CompactionResult = {
  readonly blockKey: string;
  readonly rewritten: number;
  readonly skipped: readonly CompactionSkippedEntry[];
  readonly batches: number;
};

export type CompactBlockTypeInput = {
  readonly blockKey: string;
  readonly batchSize?: number;
};

/**
 * Force-upcasts and writes back every instance of one block type that can
 * prove it can be upgraded (D-13, D-14), through `deps.recorder.run`
 * (`pages:edit` / `block.compact`). Recomputes `computeCompactionImpact`
 * inside its own transaction so a caller's earlier preview and this write
 * can never disagree. Pages through the affected rows with keyset
 * pagination (ordered by `id`, `input.batchSize ?? 500` per page) so a
 * block type with many instances never materialises all of them at once.
 *
 * Per row: `upcastOnRead` (via one shared `createUpcastSession` for the
 * whole run) resolves the current shape; a degraded outcome leaves the row
 * untouched and named in `skipped` with its reason -- this never guesses at
 * a row it cannot prove it can upgrade. A successfully upcast result is
 * then validated with `validateBlockProps` against the current definition;
 * a validation failure is ALSO left untouched and named in `skipped`,
 * rather than writing props the current schema would reject. Every
 * surviving row in a batch is rewritten in ONE statement (`props`,
 * `schema_version`, `updated_at`, and `version` bumped by one -- a
 * compaction is a real change to the row, so a concurrent editor holding an
 * older base version is told, not silently overwritten), and gets one
 * `update`-kind revision, all rewritten rows in this run sharing one
 * `revision_batch_id` so the pre-compaction props stay recoverable (D-13).
 *
 * Deliberately lock-exempt (T-04-58): this rewrites every stored instance of
 * one block type across every page that holds it, project-wide -- not a
 * single page's edit. It never calls `assertPageWritable`. A per-page edit
 * lock blocking a project-wide schema compaction would be impractical; the
 * `pages:edit` permission check and the `recorder.run` audit trail are this
 * operation's own guard.
 */
export async function compactBlockType(
  deps: PagesDeps,
  actor: AuditActor,
  input: CompactBlockTypeInput,
): Promise<CompactionResult> {
  const now = deps.now ?? (() => new Date());
  const batchSize = input.batchSize ?? DEFAULT_COMPACTION_BATCH_SIZE;
  const definition = getBlockDefinition(input.blockKey);
  const impactBefore = await computeCompactionImpact(deps.db, input.blockKey);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'block.compact',
      entityType: 'page_block',
      before: {
        blockKey: input.blockKey,
        upcastableCount: impactBefore.upcastableCount,
        blockedCount: impactBefore.blockedCount,
      },
    },
    async (tx) => {
      // Recomputed fresh inside this transaction -- not trusted from the
      // outer, pre-permission-check preview above -- so a caller's earlier
      // read and this write can never disagree (the batched SELECT loop
      // below re-derives the same guarantee against live, locked-free
      // reads of the actual rows it rewrites).
      await computeCompactionImpact(tx, input.blockKey);

      const session = createUpcastSession();
      const skipped: CompactionSkippedEntry[] = [];
      let rewritten = 0;
      let batches = 0;
      let cursor: string | null = null;
      const revisionBatchId = newRevisionBatchId();
      const updatedAt = now();

      for (;;) {
        const rows = await tx
          .select({
            id: pageBlocks.id,
            props: pageBlocks.props,
            schemaVersion: pageBlocks.schemaVersion,
            ownerType: pageBlocks.ownerType,
            ownerId: pageBlocks.ownerId,
            locale: pageBlocks.locale,
            parentBlockId: pageBlocks.parentBlockId,
            sortOrder: pageBlocks.sortOrder,
            depth: pageBlocks.depth,
          })
          .from(pageBlocks)
          .where(
            and(
              eq(pageBlocks.blockType, input.blockKey),
              ne(pageBlocks.schemaVersion, definition.schemaVersion),
              cursor === null ? undefined : gt(pageBlocks.id, cursor),
            ),
          )
          .orderBy(asc(pageBlocks.id))
          .limit(batchSize);

        if (rows.length === 0) break;
        batches += 1;
        cursor = rows[rows.length - 1]?.id ?? cursor;

        const toWrite: { readonly id: string; readonly props: unknown }[] = [];
        for (const row of rows) {
          const outcome = session.upcast(
            input.blockKey,
            row.schemaVersion,
            row.props,
          );
          if (outcome.degraded) {
            skipped.push({
              blockId: row.id,
              storedVersion: row.schemaVersion,
              reason: outcome.reason,
              ...(outcome.detail !== undefined
                ? { detail: outcome.detail }
                : {}),
            });
            continue;
          }

          let validated: Record<string, unknown>;
          try {
            validated = validateBlockProps(definition, outcome.props);
          } catch (error) {
            skipped.push({
              blockId: row.id,
              storedVersion: row.schemaVersion,
              reason: 'no-upcaster',
              detail:
                error instanceof BlockPropsValidationError
                  ? error.message
                  : String(error),
            });
            continue;
          }

          toWrite.push({ id: row.id, props: validated });
          await recordBlockRevision(tx, {
            blockId: row.id,
            owner: {
              ownerType: asOwnerType(row.ownerType),
              ownerId: row.ownerId,
              locale: row.locale,
            },
            revisionBatchId,
            changeType: 'update',
            kind: 'save',
            blockType: input.blockKey,
            parentBlockId: row.parentBlockId,
            sortOrder: row.sortOrder,
            depth: row.depth,
            props: validated,
            schemaVersion: definition.schemaVersion,
            authorId: actor.userId,
            createdAt: updatedAt,
          });
        }

        if (toWrite.length > 0) {
          await writeCompactionBatch(
            tx,
            toWrite,
            definition.schemaVersion,
            updatedAt,
          );
          rewritten += toWrite.length;
        }
      }

      return {
        result: {
          blockKey: input.blockKey,
          rewritten,
          skipped: Object.freeze(skipped),
          batches,
        },
        after: { rewritten, skipped: skipped.length, batches },
      };
    },
  );
}

/** Rewrites one batch's `props`/`schema_version`/`updated_at`, bumping
 * `version` by one, in ONE statement. Throws when the affected-row count
 * doesn't equal the batch size -- the whole batch must land together. */
async function writeCompactionBatch(
  tx: AuditTransaction,
  toWrite: readonly { readonly id: string; readonly props: unknown }[],
  currentVersion: number,
  updatedAt: Date,
): Promise<void> {
  const valuesClause = sql.join(
    toWrite.map(
      (item) => sql`(${item.id}::uuid, ${JSON.stringify(item.props)}::jsonb)`,
    ),
    sql`, `,
  );
  const result = await tx.execute(sql`
    UPDATE page_blocks SET
      props = v.props,
      schema_version = ${currentVersion},
      version = page_blocks.version + 1,
      updated_at = ${updatedAt.toISOString()}::timestamptz
    FROM (VALUES ${valuesClause}) AS v(id, props)
    WHERE page_blocks.id = v.id
  `);
  const affected = affectedRowCount(result);
  if (affected !== toWrite.length) {
    throw new Error(
      `@plakboek/pages: compaction batch affected ${affected} row(s), expected ${toWrite.length}`,
    );
  }
}

function defaultOnBelowFloorReport(event: BelowFloorEvent): void {
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-14/D-15); a host overrides deps.hooks.onBelowFloor to route elsewhere
  console.warn(
    `[@plakboek/pages] block "${event.blockKey}" has ${event.instanceCount} stored instance(s) at version(s) ${event.storedVersions.join(', ')}, below its declared floor of ${event.minSupportedVersion}`,
  );
}

/**
 * The D-14 boot report: runs `checkBlockCompatibility` against
 * `deps.config`'s registered block definitions and fires
 * `reportPagesWarning(deps.hooks?.onBelowFloor, ...)` once per below-floor
 * block type, naming its stored versions and instance count -- backed by
 * the grouped read `checkBlockCompatibility` (and `computeCompactionImpact`
 * above) both share, never a guess. Never throws and never blocks boot
 * (D-15): an `incompatible` entry is `assertBlockCompatibility`'s concern,
 * not this function's -- this one only ever reports.
 */
export async function reportBelowFloorBlocks(deps: PagesDeps): Promise<void> {
  const report = await checkBlockCompatibility(deps.db, deps.config.blocks);
  const now = deps.now ?? (() => new Date());

  for (const entry of report.belowFloor) {
    reportPagesWarning(deps.hooks?.onBelowFloor, defaultOnBelowFloorReport, {
      blockKey: entry.blockKey,
      storedVersions: entry.storedVersions,
      minSupportedVersion: entry.minSupportedVersion,
      instanceCount: entry.instanceCount,
      occurredAt: now(),
    });
  }
}
