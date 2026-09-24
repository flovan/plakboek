/**
 * Append-only key-rename history (D-09): nothing in this module updates or
 * deletes a row once written. `renameContentTypeKey` and `renameField`
 * (content-types.ts, fields.ts) call the `record*` functions here in the
 * same transaction as the rewrite they accompany, so a rename and its
 * history row always commit or roll back together. D-17's restore and
 * Phase 19's bindings are the readers.
 */
import type { AuditDatabase, AuditTransaction } from '@plakboek/auth';
import { asc, eq } from 'drizzle-orm';
import { contentFieldKeyHistory, contentTypeKeyHistory } from './schema.js';

export type RecordContentTypeKeyChangeInput = {
  readonly contentTypeId: string;
  readonly oldKey: string | null;
  readonly newKey: string;
  readonly changedBy: string | null;
  readonly changedAt: Date;
};

/** Records one content type key rename. Append-only: there is no update or
 * delete helper for this table. */
export async function recordContentTypeKeyChange(
  tx: AuditTransaction,
  input: RecordContentTypeKeyChangeInput,
): Promise<void> {
  await tx.insert(contentTypeKeyHistory).values({
    contentTypeId: input.contentTypeId,
    oldKey: input.oldKey,
    newKey: input.newKey,
    changedBy: input.changedBy,
    changedAt: input.changedAt,
  });
}

export type RecordFieldKeyChangeInput = {
  readonly contentTypeId: string;
  readonly fieldId: string;
  readonly oldKey: string | null;
  readonly newKey: string;
  readonly changedBy: string | null;
  readonly changedAt: Date;
};

/** Records one field key rename. `fieldId` carries no foreign key (see
 * `schema.ts`), so this row outlives a field that is later deleted.
 * Append-only: there is no update or delete helper for this table. */
export async function recordFieldKeyChange(
  tx: AuditTransaction,
  input: RecordFieldKeyChangeInput,
): Promise<void> {
  await tx.insert(contentFieldKeyHistory).values({
    contentTypeId: input.contentTypeId,
    fieldId: input.fieldId,
    oldKey: input.oldKey,
    newKey: input.newKey,
    changedBy: input.changedBy,
    changedAt: input.changedAt,
  });
}

export type FieldKeyHistoryEntry = {
  readonly id: number;
  readonly contentTypeId: string;
  readonly fieldId: string;
  readonly oldKey: string | null;
  readonly newKey: string;
  readonly changedBy: string | null;
  readonly changedAt: Date;
};

/** Lists a content type's field key rename history, oldest first. Not
 * permission-gated: reads are internal API, gated by later phases'
 * HTTP/admin layers. */
export async function listFieldKeyHistory(
  db: AuditDatabase,
  contentTypeId: string,
): Promise<readonly FieldKeyHistoryEntry[]> {
  return await db
    .select()
    .from(contentFieldKeyHistory)
    .where(eq(contentFieldKeyHistory.contentTypeId, contentTypeId))
    .orderBy(asc(contentFieldKeyHistory.id));
}
