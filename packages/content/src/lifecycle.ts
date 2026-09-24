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
 *
 * D-40's two reference-aware operations also live here: `trashEntry` warns
 * (via `after.referencedBy`) but always proceeds -- a trashed target is
 * still a valid reference target (`references.ts`'s
 * `assertReferencesResolvable`). `deleteEntryPermanently` is the one
 * operation that actually removes a row, gated by the superadmin-only
 * `entries:delete-permanent` permission; when the removed row was the last
 * of its translation group, it strips that group's id from every reference
 * holding it in the same transaction (T-03-62) -- the referencing entries
 * are warned about beforehand (`computeEntryPermanentDeleteImpact`), never
 * protected from the strip.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import {
  EntryNotFoundError,
  getEntry,
  loadEntryForUpdate,
  lockTranslationGroupForUpdate,
  toEntryRecord,
} from './entries.js';
import { listFields } from './fields.js';
import { assertRowsWritable, type LockableContentType } from './locks.js';
import {
  computeEntryReferenceUsage,
  removeTranslationGroupFromEntryData,
  stripTranslationGroupFromReferences,
  type EntryReferenceUsageEntry,
} from './references.js';
import { recordUrlHistory } from './routing.js';
import { StaleVersionError } from './save.js';
import { contentEntries, contentTypes, entryRevisions } from './schema.js';
import type { EntryRecord, EntryStatus } from './types.js';
import { FieldValidationError, validateEntryData } from './validation.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What collapsing a pending draft contributes to the status transition's
 * own `UPDATE`, plus the revision row that becomes obsolete by it. */
type PendingDraftCollapse = {
  readonly promote: Partial<typeof contentEntries.$inferInsert>;
  readonly obsoleteRevisionId: string | null;
};

const NO_PENDING_DRAFT: PendingDraftCollapse = {
  promote: {},
  obsoleteRevisionId: null,
};

/**
 * Reads a pending draft so the caller can collapse it onto the row (D-47).
 *
 * A pending draft is content staged on top of live content, so it only has
 * meaning while the entry is published or scheduled. Every transition out
 * of those statuses promotes the staged `data`, `seo` and `slug` onto the
 * row and clears `draft_revision_id`. Promoting rather than discarding
 * keeps the newest thing the editor wrote, and it leaves the row and its
 * working copy in agreement, so a later publish can never resurrect a stale
 * pending revision over a newer live edit.
 *
 * The caller must apply `promote` in its own `UPDATE` and only then delete
 * `obsoleteRevisionId`. `content_entries.draft_revision_id` references the
 * revision row, so the pointer has to move first. This is the ordering
 * `save.ts` already uses when it replaces a pending revision.
 *
 * Whether the superseded row survives follows `save.ts`'s own rule. In
 * `on_every_save` mode it is history (D-13) and is kept. Otherwise it is
 * ephemeral and is removed.
 */
async function readPendingDraftCollapse(
  tx: AuditTransaction,
  current: { readonly id: string; readonly draftRevisionId: string | null },
  type: LifecycleContentType,
): Promise<PendingDraftCollapse> {
  if (current.draftRevisionId === null) return NO_PENDING_DRAFT;

  const [revision] = await tx
    .select({
      data: entryRevisions.data,
      seo: entryRevisions.seo,
      slug: entryRevisions.slug,
    })
    .from(entryRevisions)
    .where(eq(entryRevisions.id, current.draftRevisionId))
    .limit(1);

  if (revision === undefined) {
    // A set pointer with no row behind it is never expected. Clear it
    // rather than carry a dangling pointer through the transition.
    return { promote: { draftRevisionId: null }, obsoleteRevisionId: null };
  }

  const keepAsHistory = type.revisions && type.revisionMode === 'on_every_save';
  return {
    promote: {
      // A revision whose `data` is not a plain object is a corrupt row. Leave
      // the entry's own `data` alone in that case rather than overwrite it
      // with a fallback, and still clear the pointer.
      ...(isPlainObject(revision.data) ? { data: revision.data } : {}),
      seo: revision.seo,
      slug: revision.slug,
      draftRevisionId: null,
    },
    obsoleteRevisionId: keepAsHistory ? null : current.draftRevisionId,
  };
}

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
type LifecycleContentType = LockableContentType & {
  readonly revisions: boolean;
  /** Compared only against `'on_every_save'` here, so the stored column type
   * is enough. `content-types.ts` owns narrowing it to `RevisionMode`. */
  readonly revisionMode: string | null;
};

async function loadLifecycleType(
  tx: AuditTransaction,
  entryId: string,
  contentTypeId: string,
): Promise<LifecycleContentType> {
  const [type] = await tx
    .select({
      editLocking: contentTypes.editLocking,
      revisions: contentTypes.revisions,
      revisionMode: contentTypes.revisionMode,
    })
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

      const collapse = await readPendingDraftCollapse(tx, current, type);

      const [row] = await tx
        .update(contentEntries)
        .set({
          ...collapse.promote,
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

      // The pointer has moved, so the superseded pending revision can go.
      if (collapse.obsoleteRevisionId !== null) {
        await tx
          .delete(entryRevisions)
          .where(eq(entryRevisions.id, collapse.obsoleteRevisionId));
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

      // Only a transition that actually lands on `draft` leaves the
      // published/scheduled pair, so only that one collapses the pending
      // draft. Unscheduling an already-published entry stays published.
      const collapse =
        nextStatus === 'draft'
          ? await readPendingDraftCollapse(tx, current, type)
          : NO_PENDING_DRAFT;

      const [row] = await tx
        .update(contentEntries)
        .set({
          ...collapse.promote,
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

      // The pointer has moved, so the superseded pending revision can go.
      if (collapse.obsoleteRevisionId !== null) {
        await tx
          .delete(entryRevisions)
          .where(eq(entryRevisions.id, collapse.obsoleteRevisionId));
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

      const collapse = await readPendingDraftCollapse(tx, current, type);

      const [row] = await tx
        .update(contentEntries)
        .set({
          ...collapse.promote,
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

      // The pointer has moved, so the superseded pending revision can go.
      if (collapse.obsoleteRevisionId !== null) {
        await tx
          .delete(entryRevisions)
          .where(eq(entryRevisions.id, collapse.obsoleteRevisionId));
      }

      // D-40: trashing always proceeds -- the reference usage count rides
      // in this audit row's `after` payload as a warning, never a block.
      // Recomputed inside this same transaction (not a pre-mutation read),
      // so it reflects what actually got trashed.
      const usage = await computeEntryReferenceUsage(tx, {
        translationGroup: current.translationGroup,
      });

      const record = toEntryRecord(row);
      return {
        result: record,
        after: {
          ...lifecycleSnapshot(record),
          referencedBy: usage.referencedBy,
        },
      };
    },
  );
}

export type EntryTrashImpact = {
  readonly status: EntryStatus;
  readonly referencedBy: number;
  readonly referencingEntries: readonly EntryReferenceUsageEntry[];
};

export type ComputeEntryTrashImpactInput = { readonly entryId: string };

/** Reports what trashing `input.entryId` would touch (D-40): its current
 * status, plus `computeEntryReferenceUsage` for its translation group --
 * "referenced by N entries" is a warning shown before trashing, never a
 * refusal. `trashEntry` recomputes this same usage inside its own
 * transaction rather than trusting this standalone read. */
export async function computeEntryTrashImpact(
  db: AuditDatabase,
  input: ComputeEntryTrashImpactInput,
): Promise<EntryTrashImpact> {
  const entry = await getEntry(db, input.entryId);
  if (entry === null) {
    throw new EntryNotFoundError(input.entryId);
  }
  const usage = await computeEntryReferenceUsage(db, {
    translationGroup: entry.translationGroup,
  });
  return {
    status: entry.status,
    referencedBy: usage.referencedBy,
    referencingEntries: usage.referencingEntries,
  };
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

export type EntryPermanentDeleteImpact = {
  readonly isLastRowOfGroup: boolean;
  readonly referencedBy: number;
  readonly referencingEntries: readonly EntryReferenceUsageEntry[];
  readonly entriesBlockedUntilRefilled: readonly string[];
};

export type ComputeEntryPermanentDeleteImpactInput = {
  readonly entryId: string;
};

/**
 * Reports what permanently deleting `input.entryId` would touch (D-40,
 * D-18). `isLastRowOfGroup` is `true` only when this locale row is the only
 * one left in its translation group -- `stripTranslationGroupFromReferences`
 * only ever runs then, since a surviving sibling row means the group (and
 * every reference to it) still exists. When it is, every referencing entry
 * `computeEntryReferenceUsage` finds is checked by actually simulating the
 * strip (`removeTranslationGroupFromEntryData`) against its current fields
 * and data, then re-running `validateEntryData`: an entry that would fail
 * with a `REQUIRED` issue is listed in `entriesBlockedUntilRefilled` --
 * D-18's existing "required field, no value" rule, applied to a reference
 * losing its target rather than a new rule of its own. Read-only, and typed
 * to accept a transaction handle too, so `deleteEntryPermanently` recomputes
 * this same impact inside its own transaction rather than trusting a stale
 * preview.
 */
export async function computeEntryPermanentDeleteImpact(
  db: AuditDatabase,
  input: ComputeEntryPermanentDeleteImpactInput,
): Promise<EntryPermanentDeleteImpact> {
  const entry = await getEntry(db, input.entryId);
  if (entry === null) {
    throw new EntryNotFoundError(input.entryId);
  }

  const [groupCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntries)
    .where(eq(contentEntries.translationGroup, entry.translationGroup));
  const isLastRowOfGroup = (groupCountRow?.count ?? 1) <= 1;

  const usage = await computeEntryReferenceUsage(db, {
    translationGroup: entry.translationGroup,
  });

  const entriesBlockedUntilRefilled: string[] = [];
  if (isLastRowOfGroup) {
    const checkedEntryIds = new Set<string>();
    for (const referencing of usage.referencingEntries) {
      if (checkedEntryIds.has(referencing.entryId)) continue;
      checkedEntryIds.add(referencing.entryId);

      const referencingEntry = await getEntry(db, referencing.entryId);
      if (referencingEntry === null) continue;

      const referencingFields = await listFields(
        db,
        referencingEntry.contentTypeId,
      );
      const { data: strippedData } = removeTranslationGroupFromEntryData(
        referencingFields,
        referencingEntry.data,
        entry.translationGroup,
      );
      try {
        validateEntryData(referencingFields, strippedData);
      } catch (error) {
        if (!(error instanceof FieldValidationError)) throw error;
        if (error.issues.some((issue) => issue.code === 'REQUIRED')) {
          entriesBlockedUntilRefilled.push(referencing.entryId);
        }
      }
    }
  }

  return {
    isLastRowOfGroup,
    referencedBy: usage.referencedBy,
    referencingEntries: usage.referencingEntries,
    entriesBlockedUntilRefilled,
  };
}

/** The `before` shape `deleteEntryPermanently` audits: identifying columns
 * only, never `data` -- the row is about to be gone, so there is no `after`
 * row to compare it against either way. */
function permanentDeleteBeforeSnapshot(entry: EntryRecord) {
  return {
    id: entry.id,
    contentTypeId: entry.contentTypeId,
    translationGroup: entry.translationGroup,
    locale: entry.locale,
    version: entry.version,
  };
}

export type DeleteEntryPermanentlyInput = {
  readonly entryId: string;
  readonly baseVersion: number;
};

/**
 * Permanently deletes one locale row (D-40), for a role holding the
 * superadmin-only `entries:delete-permanent` permission -- distinct from
 * `entries:delete`'s trash/restore, matching `pages:delete-permanent`'s own
 * split in the permissions catalogue. Locks the row's whole translation
 * group (`lockTranslationGroupForUpdate`, so a concurrent delete of a
 * sibling locale row -- or a concurrent save adding a fresh reference to
 * this very group -- serializes against this one), checks its version
 * (D-42) and edit lock (D-43/D-45) exactly like every other operation in
 * this module, then recomputes `computeEntryPermanentDeleteImpact` inside
 * this same transaction before deleting the row.
 *
 * Only when the deleted row was the last of its group does this call
 * `stripTranslationGroupFromReferences` -- a surviving sibling locale row
 * means the group, and every reference to it, still exists. `before`
 * carries the entry's identifying columns; `after` carries `{
 * strippedFrom, referencedBy, entriesBlockedUntilRefilled }` -- the
 * entries the strip actually changed, how many entries referenced this
 * group, and which of them are now blocked from saving until the
 * reference is refilled (D-18's rule, warned about, never protected
 * against). Revision rows cascade-delete with the entry (`entry_revisions`'
 * own FK); URL history rows keep their own `SET NULL` FK behaviour. Runs
 * through `deps.recorder.run` (`entries:delete-permanent` /
 * `entry.delete-permanent`).
 */
export async function deleteEntryPermanently(
  deps: ContentDeps,
  actor: AuditActor,
  input: DeleteEntryPermanentlyInput,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  await deps.recorder.run(
    actor,
    {
      permission: 'entries:delete-permanent',
      action: 'entry.delete-permanent',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null
        ? {}
        : { before: permanentDeleteBeforeSnapshot(before) }),
    },
    async (tx) => {
      const { origin: current } = await lockTranslationGroupForUpdate(
        tx,
        deps.config,
        input.entryId,
      );
      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }

      const type = await loadLifecycleType(
        tx,
        input.entryId,
        current.contentTypeId,
      );
      assertRowsWritable([current], type, actor.userId, now());

      const impact = await computeEntryPermanentDeleteImpact(tx, {
        entryId: input.entryId,
      });

      await tx
        .delete(contentEntries)
        .where(eq(contentEntries.id, input.entryId));

      let strippedFrom: readonly string[] = [];
      if (impact.isLastRowOfGroup) {
        strippedFrom = await stripTranslationGroupFromReferences(tx, {
          translationGroup: current.translationGroup,
          changedAt: now(),
          changedBy: actor.userId,
        });
      }

      return {
        result: undefined,
        after: {
          strippedFrom,
          referencedBy: impact.referencedBy,
          entriesBlockedUntilRefilled: impact.entriesBlockedUntilRefilled,
        },
      };
    },
  );
}
