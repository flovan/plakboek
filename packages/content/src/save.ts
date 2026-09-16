/**
 * Version-checked, validated, audited entry saves (D-42, D-12). Every save
 * carries the version it started from; a stale save changes nothing. This
 * module's structure -- load, lock the type row, validate, update, audit --
 * is the contract plans 03-06, 03-07, 03-09, 03-10 and 03-12 extend.
 */
import type { AuditActor } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { getEntry, loadEntryForUpdate, toEntryRecord } from './entries.js';
import { listFields } from './fields.js';
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
 * against mid-transaction), validates `data` against the content type's
 * current fields (FIELD-06, D-12, drafts included), then updates `data` and
 * increments `version` in one conditional `UPDATE` whose `WHERE` clause
 * names `input.baseVersion` -- the sole staleness check. Runs through
 * `deps.recorder.run` (`entries:edit` / `entry.save`). A stale
 * `baseVersion`, sequential or lost to a concurrent save, makes the
 * `UPDATE` match zero rows, which throws `StaleVersionError`.
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
      // otherwise) and locks the row for the duration of this transaction;
      // its own `.version` is not compared here -- the conditional UPDATE
      // below is what actually detects a stale `baseVersion`, including a
      // save that lost a race to a concurrent one holding the same lock.
      const current = await loadEntryForUpdate(tx, input.entryId);

      // Locks the type row for the duration of this save, so a concurrent
      // field delete/rename can't remove a field this save is about to
      // validate against mid-transaction.
      await tx
        .select({ id: contentTypes.id })
        .from(contentTypes)
        .where(eq(contentTypes.id, current.contentTypeId))
        .for('share');

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
