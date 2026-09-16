/**
 * Version-checked, lock-checked, validated, audited entry saves (D-42, D-43,
 * D-45, D-12). Every save carries the version it started from; a stale save
 * changes nothing. This module's structure -- load, check version, lock the
 * type row, check the edit lock, validate, update, audit -- is the contract
 * plans 03-06, 03-07, 03-09, 03-10 and 03-12 extend.
 */
import type { AuditActor } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { getEntry, loadEntryForUpdate, toEntryRecord } from './entries.js';
import { listFields } from './fields.js';
import { assertRowsWritable } from './locks.js';
import { contentEntries, contentTypes } from './schema.js';
import type { EntryRecord } from './types.js';
import { validateEntryData } from './validation.js';

export type SaveEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
  readonly data: unknown;
};

/** Thrown when `baseVersion` no longer matches the row's current version --
 * on every content type, whether or not edit locking is enabled (D-42). */
export class StaleVersionError extends Error {
  readonly entryId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(entryId: string, expectedVersion: number, actualVersion: number) {
    super(
      `@plakboek/content: entry "${entryId}" was modified by someone else since it was loaded (expected version ${expectedVersion}, now ${actualVersion})`,
    );
    this.name = 'StaleVersionError';
    this.entryId = entryId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Saves an entry: loads and locks its row (so a concurrent field
 * delete/rename can't remove a field this save is about to validate
 * against mid-transaction), checks its version against `input.baseVersion`
 * (D-42, every type, whether or not edit locking is on), then checks the
 * edit lock (D-43/D-45, `assertRowsWritable` -- a no-op on a type without
 * edit locking) before validating `data` against the content type's current
 * fields (FIELD-06, D-12, drafts included) and writing the update. Version
 * check first, then lock check: a previous holder whose lock was taken over
 * sees `StaleVersionError`, not `EntryLockedError`, exactly as D-44
 * describes. Runs through `deps.recorder.run` (`entries:edit` /
 * `entry.save`). The final `UPDATE`'s `WHERE` clause still names
 * `input.baseVersion` as a defensive second check -- it always matches at
 * that point because the row has been locked `FOR UPDATE` since the first
 * check, but a mismatch there also throws `StaleVersionError`.
 */
export async function saveEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: SaveEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:edit',
      action: 'entry.save',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null
        ? {}
        : {
            before: {
              version: before.version,
              status: before.status,
              data: before.data,
            },
          }),
    },
    async (tx) => {
      // loadEntryForUpdate both confirms the entry exists (EntryNotFoundError
      // otherwise) and locks the row FOR UPDATE for the duration of this
      // transaction, so the explicit version check below and the final
      // UPDATE's WHERE clause can never disagree with each other.
      const current = await loadEntryForUpdate(tx, input.entryId);

      // Version check first (D-42, D-44): a base version that no longer
      // matches is a conflict regardless of locking. The row is already
      // locked FOR UPDATE, so nothing can change its version between this
      // check and the final UPDATE below.
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }

      // Locks the type row for the duration of this save, so a concurrent
      // field delete/rename can't remove a field this save is about to
      // validate against mid-transaction; also carries editLocking for the
      // lock check below.
      const [type] = await tx
        .select({ editLocking: contentTypes.editLocking })
        .from(contentTypes)
        .where(eq(contentTypes.id, current.contentTypeId))
        .for('share');
      if (type === undefined) {
        throw new Error(
          `@plakboek/content: no content type found for entry "${input.entryId}"`,
        );
      }

      // Lock check second (D-43/D-45): refuses when another user holds a
      // live lock on this row; a no-op when the type has no edit locking.
      assertRowsWritable([current], type, actor.userId, now());

      const fields = await listFields(tx, current.contentTypeId);
      const validated = validateEntryData(fields, input.data);

      const [row] = await tx
        .update(contentEntries)
        .set({
          data: validated,
          version: sql`${contentEntries.version} + 1`,
          updatedAt: now(),
          updatedBy: actor.userId,
        })
        .where(
          and(
            eq(contentEntries.id, input.entryId),
            eq(contentEntries.version, input.baseVersion),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }
      const record = toEntryRecord(row);
      return {
        result: record,
        after: {
          version: record.version,
          status: record.status,
          data: record.data,
        },
      };
    },
  );
}
