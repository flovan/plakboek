/**
 * Read-only impact report types and shared counting queries (D-07, D-09,
 * D-10, D-18, D-23, D-32): every destructive-but-allowed schema change
 * computes one of these before applying, and the mutation re-runs the same
 * kind of query inside its own transaction so the counts committed always
 * match the counts actually applied -- never the numbers a caller saw at
 * preview time, which could be stale by the time the mutation runs.
 *
 * `AuditTransaction` (drizzle's `PgTransaction`) extends `AuditDatabase`
 * (`PgDatabase`), so every helper below typed to take an `AuditDatabase`
 * accepts a transaction handle too -- one implementation serves both a
 * standalone `compute*Impact` read and the same query re-run inside a
 * mutation's transaction.
 */
import type { AuditDatabase } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import { contentEntries } from './schema.js';

/** One field that lists a content type's key in its `reference` options --
 * either directly, or as a repeater sub-field. `path` is the field's own key
 * for a direct reference, or `"<fieldKey>.<subFieldKey>"` for a repeater
 * sub-field. */
export type ReferencingField = {
  readonly contentTypeKey: string;
  readonly fieldKey: string;
  readonly path: string;
};

export type ContentTypeDeleteImpact = {
  readonly entryCount: number;
  readonly referencingFields: readonly ReferencingField[];
};

export type ContentTypeKeyRenameImpact = {
  readonly entryCount: number;
  readonly referencingFields: readonly ReferencingField[];
  /** Always `0` today: Phase 19 bindings are the only other consumer of a
   * key, and they don't exist yet. Replaced with a real count once they
   * ship. */
  readonly bindingsUsingKey: 0;
};

export type FieldKeyUsage = {
  readonly entriesHoldingValue: number;
  /** See `ContentTypeKeyRenameImpact.bindingsUsingKey`. */
  readonly bindingsUsingKey: 0;
  readonly suggestDuplicate: boolean;
};

export type FieldDeleteImpact = {
  readonly entriesHoldingValue: number;
  readonly clearsTitleField: boolean;
  /** See `ContentTypeKeyRenameImpact.bindingsUsingKey`. */
  readonly bindingsUsingKey: 0;
};

export type AddFieldImpact = {
  readonly entryCount: number;
  readonly entriesToBackfill: number;
  readonly entriesBlockedUntilFilled: number;
};

export type FieldUpdateImpact = {
  readonly entriesFailingNewRules: number;
  readonly entriesToBackfill: number;
  readonly repeaterItemsLosingValues: number;
};

/** Counts every entry of a content type, every status and locale included
 * (D-10: a type "holding any entry, trashed entries included" can't be
 * deleted). */
export async function countEntries(
  db: AuditDatabase,
  contentTypeId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntries)
    .where(eq(contentEntries.contentTypeId, contentTypeId));
  return row?.count ?? 0;
}

/** Counts entries of a content type whose `data` holds `key`, via
 * `jsonb_exists` -- `key` is always bound as a parameter, never
 * interpolated into SQL text (T-03-22). */
export async function countEntriesHoldingKey(
  db: AuditDatabase,
  contentTypeId: string,
  key: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.contentTypeId, contentTypeId),
        sql`jsonb_exists(${contentEntries.data}, ${key})`,
      ),
    );
  return row?.count ?? 0;
}
