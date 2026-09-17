/**
 * The project-wide revision cap (D-14): one setting, not per content type,
 * bounding how many `save`-kind revisions `pruneSaveRevisions` keeps per
 * entry in on-every-save mode. `0` means uncapped -- the project's
 * deliberate default, and always a valid value to set. Read and written
 * through the single-row `content_engine_settings` table (seeded by
 * `0002_content_engine`'s migration), never per content type.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { pruneSaveRevisions } from './revisions.js';
import { contentEngineSettings } from './schema.js';

const SETTINGS_ROW_ID = 1;

/** Thrown by `setRevisionCap` when `cap` is not a non-negative safe
 * integer -- a negative cap is meaningless, and `0` ("uncapped") is always
 * valid, never rejected. */
export class RevisionCapError extends Error {
  readonly cap: unknown;

  constructor(cap: unknown) {
    super(
      `@plakboek/content: revision cap must be a non-negative integer (got ${JSON.stringify(cap)})`,
    );
    this.name = 'RevisionCapError';
    this.cap = cap;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reads the single project-wide revision cap (D-14); `0` means uncapped.
 * The settings row is a fixed singleton seeded by migration, so this only
 * falls back to `0` itself in the defensive case where the row is somehow
 * missing. */
export async function getRevisionCap(db: AuditDatabase): Promise<number> {
  const [row] = await db
    .select({ revisionCap: contentEngineSettings.revisionCap })
    .from(contentEngineSettings)
    .where(eq(contentEngineSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  return row?.revisionCap ?? 0;
}

export type RevisionCapImpact = {
  readonly entriesAffected: number;
  readonly revisionsToPrune: number;
};

function asCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Rows from a raw `execute()` result across drivers: postgres-js returns
 * the row array directly, node-postgres nests it under `.rows`. */
function resultRows(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (typeof result === 'object' && result !== null) {
    const rows: unknown = Reflect.get(result, 'rows');
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/**
 * Reports what lowering the project-wide cap to `cap` would prune (D-16):
 * how many distinct entries hold at least one prunable `save` revision, and
 * how many rows in total -- ranked beyond `cap` per entry
 * (`created_at DESC, id DESC`), excluding any row referenced by
 * `draft_revision_id`/`live_revision_id`. `publish`-kind rows are never
 * counted. `cap <= 0` (uncapped) always reports zero without a statement.
 * Read-only, and typed to accept a transaction handle too, so
 * `setRevisionCap` re-runs this same query inside its own transaction --
 * the counts it applies always match what was previewed.
 */
export async function computeRevisionCapImpact(
  db: AuditDatabase,
  cap: number,
): Promise<RevisionCapImpact> {
  if (cap <= 0) {
    return { entriesAffected: 0, revisionsToPrune: 0 };
  }

  const result: unknown = await db.execute(sql`
    WITH ranked AS (
      SELECT id, entry_id,
        row_number() OVER (
          PARTITION BY entry_id ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM entry_revisions
      WHERE kind = 'save'
    ),
    prunable AS (
      SELECT ranked.id, ranked.entry_id
      FROM ranked
      WHERE ranked.rn > ${cap}
        AND ranked.id NOT IN (
          SELECT draft_revision_id FROM content_entries WHERE draft_revision_id IS NOT NULL
          UNION
          SELECT live_revision_id FROM content_entries WHERE live_revision_id IS NOT NULL
        )
    )
    SELECT
      count(DISTINCT entry_id)::int AS entries_affected,
      count(*)::int AS revisions_to_prune
    FROM prunable
  `);
  const [row] = resultRows(result);
  return {
    entriesAffected: asCount(row?.entries_affected),
    revisionsToPrune: asCount(row?.revisions_to_prune),
  };
}

export type SetRevisionCapInput = {
  readonly cap: number;
};

export type SetRevisionCapResult = {
  readonly cap: number;
  readonly pruned: number;
};

/**
 * Sets the project-wide revision cap (D-14, D-16), for a role holding
 * `settings:manage`. `cap` must be a non-negative safe integer
 * (`RevisionCapError` otherwise -- `-1` throws, `0` is always valid).
 * Whenever the new cap is positive, immediately sweeps every entry's
 * `save` revisions down to it in the same transaction
 * (`pruneSaveRevisions` with no `entryId`); the sweep is idempotent, so
 * raising a positive cap, or setting it to the value it already has,
 * simply finds nothing to prune. Runs through `deps.recorder.run`
 * (`settings:manage` / `settings.revision-cap`); `after` carries
 * `{ cap, pruned }`.
 */
export async function setRevisionCap(
  deps: ContentDeps,
  actor: AuditActor,
  input: SetRevisionCapInput,
): Promise<SetRevisionCapResult> {
  if (!isNonNegativeSafeInteger(input.cap)) {
    throw new RevisionCapError(input.cap);
  }
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'settings:manage',
      action: 'settings.revision-cap',
      entityType: 'content_engine_settings',
      entityId: String(SETTINGS_ROW_ID),
    },
    async (tx) => {
      const updatedAt = now();
      await tx
        .update(contentEngineSettings)
        .set({ revisionCap: input.cap, updatedAt })
        .where(eq(contentEngineSettings.id, SETTINGS_ROW_ID));

      const pruned =
        input.cap > 0 ? await pruneSaveRevisions(tx, { cap: input.cap }) : 0;

      const result: SetRevisionCapResult = { cap: input.cap, pruned };
      return { result, after: result };
    },
  );
}
