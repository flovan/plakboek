/**
 * Unpublish, scheduling, trash and restore-from-trash (D-47, D-48, D-49):
 * the entry status transitions around publish that `publish.ts` doesn't
 * cover. Each operation follows `save.ts`/`publish.ts`'s contract -- load
 * and lock the row (`FOR UPDATE`), check its version (D-42), lock the type
 * row (`FOR SHARE`), check the edit lock (`assertRowsWritable`, D-43/D-45),
 * then apply one `UPDATE` that bumps `version` and `updated_at`/
 * `updated_by`.
 *
 * Unpublishing and trashing both give up a live URL, so both record it in
 * `content_entry_url_history` (D-33) before clearing `resolved_path`. None
 * of these operations ever set `status` to `published` -- that transition
 * belongs to `publishEntry` alone (`publish.ts`).
 *
 * `scheduled_at`/`scheduled` shipped in this phase's schema (D-49), and
 * `scheduleEntry`/`unscheduleEntry` here only record or clear that intent.
 * The job that actually publishes an entry once `scheduled_at` arrives is
 * Phase 13's (PUB-04) -- nothing in this module publishes anything.
 */
import type { AuditActor, AuditTransaction } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { getEntry, loadEntryForUpdate, toEntryRecord } from './entries.js';
import { assertRowsWritable, type LockableContentType } from './locks.js';
import { recordUrlHistory } from './routing.js';
import { StaleVersionError } from './save.js';
import { contentEntries, contentTypes } from './schema.js';
import type { EntryRecord, EntryStatus } from './types.js';

/** Thrown when an entry's current status doesn't allow the requested
 * lifecycle operation. `operation` names the attempted transition:
 * `'unpublish'`, `'schedule'`, `'unschedule'`, `'trash'` or
 * `'restore-from-trash'`. */
export class EntryStatusError extends Error {
  readonly entryId: string;
  readonly status: EntryStatus;
  readonly operation: string;

  constructor(entryId: string, status: EntryStatus, operation: string) {
    super(
      `@plakboek/content: entry "${entryId}" has status "${status}" and cannot be "${operation}"-ed`,
    );
    this.name = 'EntryStatusError';
    this.entryId = entryId;
    this.status = status;
    this.operation = operation;
  }
}

/** Thrown by `scheduleEntry` when `scheduledAt` is not strictly after the
 * clock's current instant -- scheduling for "now" or a past instant would
 * never fire. */
export class ScheduleNotInFutureError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(
      `@plakboek/content: entry "${entryId}" cannot be scheduled for now or a past instant`,
    );
    this.name = 'ScheduleNotInFutureError';
    this.entryId = entryId;
  }
}

/** The `before`/`after` shape every lifecycle operation audits: the status
 * fields it can change, never the entry's `data`. */
function lifecycleSnapshot(entry: EntryRecord) {
  return {
    version: entry.version,
    status: entry.status,
    resolvedPath: entry.resolvedPath,
    scheduledAt: entry.scheduledAt,
    trashedAt: entry.trashedAt,
  };
}

/** Loads and locks (`FOR SHARE`) the content type row a lifecycle mutation
 * needs to check its edit lock against. */
async function loadLifecycleType(
  tx: AuditTransaction,
  entryId: string,
  contentTypeId: string,
): Promise<LockableContentType> {
  const [type] = await tx
    .select({ editLocking: contentTypes.editLocking })
    .from(contentTypes)
    .where(eq(contentTypes.id, contentTypeId))
    .for('share');
  if (type === undefined) {
    throw new Error(
      `@plakboek/content: no content type found for entry "${entryId}"`,
    );
  }
  return type;
}

export type UnpublishEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
};

/**
 * Unpublishes a published entry (D-48), for a role holding `entries:publish`.
 * Only allowed from `published` (`EntryStatusError` otherwise): `status`
 * becomes `draft`, `resolved_path` is cleared and, when it was set, recorded
 * in URL history first with reason `unpublished`; `scheduled_at` is cleared
 * too. Content, `slug`, `first_published_at`, `draft_revision_id` and every
 * revision row are left untouched, so a later `publishEntry` call resolves
 * the same path again. Runs through `deps.recorder.run` (`entries:publish` /
 * `entry.unpublish`).
 */
export async function unpublishEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: UnpublishEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:publish',
      action: 'entry.unpublish',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadEntryForUpdate(tx, deps.config, input.entryId);
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status !== 'published') {
        throw new EntryStatusError(input.entryId, current.status, 'unpublish');
      }

      const type = await loadLifecycleType(
        tx,
        input.entryId,
        current.contentTypeId,
      );
      assertRowsWritable([current], type, actor.userId, now());

      const updatedAt = now();
      if (current.resolvedPath !== null) {
        await recordUrlHistory(tx, {
          entryId: current.id,
          contentTypeId: current.contentTypeId,
          translationGroup: current.translationGroup,
          locale: current.locale,
          oldPath: current.resolvedPath,
          reason: 'unpublished',
          changedAt: updatedAt,
        });
      }

      const [row] = await tx
        .update(contentEntries)
        .set({
          status: 'draft',
          resolvedPath: null,
          scheduledAt: null,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
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
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

export type ScheduleEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
  readonly scheduledAt: Date;
};

/**
 * Schedules an entry for a future instant (D-49), for a role holding
 * `entries:publish`. Refused with `EntryStatusError` from `trashed`;
 * otherwise a `draft` or already-`scheduled` entry becomes `scheduled`,
 * while a `published` entry stays `published` -- both ways `scheduled_at`
 * is set to `input.scheduledAt`. `input.scheduledAt` at or before the
 * clock's current instant throws `ScheduleNotInFutureError` instead of
 * writing anything. This never publishes anything itself: the job that
 * publishes an entry once `scheduled_at` arrives is Phase 13's (PUB-04).
 * Runs through `deps.recorder.run` (`entries:publish` / `entry.schedule`).
 */
export async function scheduleEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: ScheduleEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:publish',
      action: 'entry.schedule',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadEntryForUpdate(tx, deps.config, input.entryId);
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status === 'trashed') {
        throw new EntryStatusError(input.entryId, current.status, 'schedule');
      }

      const type = await loadLifecycleType(
        tx,
        input.entryId,
        current.contentTypeId,
      );
      assertRowsWritable([current], type, actor.userId, now());

      const updatedAt = now();
      if (input.scheduledAt.getTime() <= updatedAt.getTime()) {
        throw new ScheduleNotInFutureError(input.entryId);
      }

      const nextStatus: EntryStatus =
        current.status === 'published' ? current.status : 'scheduled';

      const [row] = await tx
        .update(contentEntries)
        .set({
          status: nextStatus,
          scheduledAt: input.scheduledAt,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
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
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

export type UnscheduleEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
};

/**
 * Cancels a pending schedule (D-49), for a role holding `entries:publish`.
 * A `scheduled` entry returns to `draft` with `scheduled_at` cleared; a
 * `published` entry with `scheduled_at` still set just clears it, keeping
 * its own status. Any other current state -- nothing scheduled to cancel --
 * throws `EntryStatusError`. Runs through `deps.recorder.run`
 * (`entries:publish` / `entry.unschedule`).
 */
export async function unscheduleEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: UnscheduleEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:publish',
      action: 'entry.unschedule',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadEntryForUpdate(tx, deps.config, input.entryId);
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }
      const canUnschedule =
        current.status === 'scheduled' ||
        (current.status === 'published' && current.scheduledAt !== null);
      if (!canUnschedule) {
        throw new EntryStatusError(input.entryId, current.status, 'unschedule');
      }

      const type = await loadLifecycleType(
        tx,
        input.entryId,
        current.contentTypeId,
      );
      assertRowsWritable([current], type, actor.userId, now());

      const updatedAt = now();
      const nextStatus: EntryStatus =
        current.status === 'scheduled' ? 'draft' : current.status;

      const [row] = await tx
        .update(contentEntries)
        .set({
          status: nextStatus,
          scheduledAt: null,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
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
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

export type TrashEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
};

/**
 * Trashes an entry (D-47, D-40's "trash proceeds"), for a role holding
 * `entries:delete`. Allowed from any status but `trashed`
 * (`EntryStatusError` otherwise): `status` becomes `trashed`, `trashed_at`
 * is set to now, `scheduled_at` is cleared, and -- when the entry had a live
 * path -- it is recorded in URL history with reason `trashed` before
 * `resolved_path` is cleared. Runs through `deps.recorder.run`
 * (`entries:delete` / `entry.trash`).
 */
export async function trashEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: TrashEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:delete',
      action: 'entry.trash',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadEntryForUpdate(tx, deps.config, input.entryId);
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status === 'trashed') {
        throw new EntryStatusError(input.entryId, current.status, 'trash');
      }

      const type = await loadLifecycleType(
        tx,
        input.entryId,
        current.contentTypeId,
      );
      assertRowsWritable([current], type, actor.userId, now());

      const updatedAt = now();
      if (current.resolvedPath !== null) {
        await recordUrlHistory(tx, {
          entryId: current.id,
          contentTypeId: current.contentTypeId,
          translationGroup: current.translationGroup,
          locale: current.locale,
          oldPath: current.resolvedPath,
          reason: 'trashed',
          changedAt: updatedAt,
        });
      }

      const [row] = await tx
        .update(contentEntries)
        .set({
          status: 'trashed',
          trashedAt: updatedAt,
          resolvedPath: null,
          scheduledAt: null,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
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
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

export type RestoreEntryFromTrashInput = {
  readonly entryId: string;
  readonly baseVersion: number;
};

/**
 * Restores a trashed entry to `draft` (D-40) -- never straight back to a
 * live state, since re-publishing is a deliberate act a role holding
 * `entries:publish` takes separately. Refused with `EntryStatusError` when
 * the entry isn't currently `trashed`. Runs through `deps.recorder.run`
 * (`entries:delete` / `entry.restore-from-trash`).
 */
export async function restoreEntryFromTrash(
  deps: ContentDeps,
  actor: AuditActor,
  input: RestoreEntryFromTrashInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:delete',
      action: 'entry.restore-from-trash',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadEntryForUpdate(tx, deps.config, input.entryId);
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status !== 'trashed') {
        throw new EntryStatusError(
          input.entryId,
          current.status,
          'restore-from-trash',
        );
      }

      const type = await loadLifecycleType(
        tx,
        input.entryId,
        current.contentTypeId,
      );
      assertRowsWritable([current], type, actor.userId, now());

      const updatedAt = now();
      const [row] = await tx
        .update(contentEntries)
        .set({
          status: 'draft',
          trashedAt: null,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
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
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}
