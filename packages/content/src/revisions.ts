/**
 * Revision snapshots per content type (TYPE-08, D-13 through D-17):
 * `save.ts`/`publish.ts` call `recordRevision` to write one immutable row
 * per snapshot, and `pruneSaveRevisions` to bound `save`-kind history to
 * the project-wide cap (`settings.ts`). This module defines no update for
 * `entry_revisions` -- once written, a revision row is only ever read,
 * pruned (by rank, never a `publish` row, never a row a pointer
 * references) or left alone.
 *
 * Restoring (`computeRestorePreview`, `restoreRevision`) maps a snapshot's
 * keys onto today's field keys through the field ids captured in
 * `field_ids` at snapshot time -- falling back to
 * `content_field_key_history` when a snapshot predates that capture -- and
 * replays the mapped data through `saveEntryInTransaction`, the exact same
 * transaction body an ordinary `saveEntry` runs (T-03-41): drafts, locks,
 * versions and slugs all behave identically, and a restore that fails
 * validation changes nothing.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { desc, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { EntryNotFoundError, getEntry } from './entries.js';
import { listFields } from './fields.js';
import { listFieldKeyHistory } from './key-history.js';
import {
  decideSavePermission,
  entrySnapshot,
  saveEntryInTransaction,
} from './save.js';
import { entryRevisions } from './schema.js';
import type { EntryRecord, FieldDefinition } from './types.js';
import {
  FieldValidationError,
  validateEntryData,
  type FieldValidationIssue,
} from './validation.js';

export type RevisionKind = 'save' | 'publish';

function asRevisionKind(value: string): RevisionKind {
  if (value === 'save' || value === 'publish') return value;
  throw new TypeError(
    `@plakboek/content: unexpected kind "${value}" stored for an entry revision`,
  );
}

export type RecordRevisionInput = {
  readonly entryId: string;
  readonly locale: string;
  readonly kind: RevisionKind;
  readonly data: Readonly<Record<string, unknown>>;
  readonly seo: unknown;
  readonly slug: string | null;
  readonly fields: readonly FieldDefinition[];
  readonly authorId: string | null;
  readonly createdAt: Date;
};

/**
 * Inserts one immutable snapshot row (D-15, D-17): `field_ids` maps every
 * key actually present in `data` to the field id that held it at this
 * instant -- read back later by `computeRestorePreview` even if the field
 * is renamed again, or dropped entirely, after this snapshot is taken.
 * Insert-only: this function, `pruneSaveRevisions`'s bounded delete and a
 * caller's own `tx.delete` for a superseded pending revision are the only
 * writes this module makes to `entry_revisions` -- there is no update.
 */
export async function recordRevision(
  tx: AuditTransaction,
  input: RecordRevisionInput,
): Promise<string> {
  const fieldIds: Record<string, string> = {};
  for (const field of input.fields) {
    if (Object.hasOwn(input.data, field.key)) {
      fieldIds[field.key] = field.id;
    }
  }

  const [row] = await tx
    .insert(entryRevisions)
    .values({
      entryId: input.entryId,
      locale: input.locale,
      kind: input.kind,
      data: input.data,
      fieldIds,
      seo: input.seo,
      slug: input.slug,
      authorId: input.authorId,
      createdAt: input.createdAt,
    })
    .returning({ id: entryRevisions.id });
  if (row === undefined) {
    throw new Error('@plakboek/content: entry revision insert returned no row');
  }
  return row.id;
}

/** Reads an affected-row count from a raw `execute()` result across
 * drivers: postgres-js reports `count`, node-postgres reports `rowCount`.
 * Mirrors `@plakboek/auth`'s `pruneAuditLog` helper of the same shape.
 *
 * Throwing rather than defaulting to `0` is deliberate (A-WR-01). Both
 * supported drivers always report one of the two, including for a zero-row
 * DELETE, so this branch is unreachable on a supported driver and only fires
 * on one this package has never been tested against. Defaulting to `0` there
 * would silently under-report how much was pruned, which is worse than a
 * loud failure, because the count is what the caller is told was removed. */
function affectedRowCount(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    for (const property of ['count', 'rowCount']) {
      const value: unknown = Reflect.get(result, property);
      if (typeof value === 'number') return value;
    }
  }
  throw new TypeError(
    '@plakboek/content: could not read the affected row count from the database driver',
  );
}

export type PruneSaveRevisionsInput = {
  readonly cap: number;
  readonly entryId?: string;
};

/**
 * Deletes `save`-kind revisions ranked beyond `cap` per `entry_id` (newest
 * first: `created_at DESC, id DESC`), skipping any row referenced by
 * `content_entries.draft_revision_id` or `.live_revision_id` regardless of
 * its rank -- a row still pointed to is never pruned (D-14, D-15).
 * `publish`-kind rows are never selected: only `save`-kind history counts
 * toward the cap. `cap <= 0` (uncapped) is a no-op returning `0` without
 * running a statement. `entryId` scopes the delete to one entry (the
 * common case, called right after that entry's own save); omitted, it
 * sweeps every entry project-wide (`setRevisionCap`, after lowering the
 * cap). Returns the number of rows deleted.
 */
export async function pruneSaveRevisions(
  tx: AuditTransaction,
  input: PruneSaveRevisionsInput,
): Promise<number> {
  if (input.cap <= 0) return 0;

  const entryFilter =
    input.entryId !== undefined ? sql`AND entry_id = ${input.entryId}` : sql``;

  const result: unknown = await tx.execute(sql`
    WITH ranked AS (
      SELECT id, entry_id,
        row_number() OVER (
          PARTITION BY entry_id ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM entry_revisions
      WHERE kind = 'save' ${entryFilter}
    )
    DELETE FROM entry_revisions
    WHERE id IN (SELECT id FROM ranked WHERE rn > ${input.cap})
      AND id NOT IN (
        SELECT draft_revision_id FROM content_entries WHERE draft_revision_id IS NOT NULL
        UNION
        SELECT live_revision_id FROM content_entries WHERE live_revision_id IS NOT NULL
      )
  `);
  return affectedRowCount(result);
}

export type RevisionSummary = {
  readonly id: string;
  readonly kind: RevisionKind;
  readonly createdAt: Date;
  readonly authorId: string | null;
};

export type ListRevisionsInput = { readonly entryId: string };

/** Lists one entry's revisions, newest first (`created_at DESC, id DESC`).
 * Not permission-gated: reads are internal API, gated by later phases'
 * HTTP/admin layers. */
export async function listRevisions(
  db: AuditDatabase,
  input: ListRevisionsInput,
): Promise<readonly RevisionSummary[]> {
  const rows = await db
    .select({
      id: entryRevisions.id,
      kind: entryRevisions.kind,
      createdAt: entryRevisions.createdAt,
      authorId: entryRevisions.authorId,
    })
    .from(entryRevisions)
    .where(eq(entryRevisions.entryId, input.entryId))
    .orderBy(desc(entryRevisions.createdAt), desc(entryRevisions.id));
  return rows.map((row) => ({
    id: row.id,
    kind: asRevisionKind(row.kind),
    createdAt: row.createdAt,
    authorId: row.authorId,
  }));
}

/** Thrown by `computeRestorePreview`/`restoreRevision` when `revisionId`
 * doesn't exist, or exists but belongs to a different entry. */
export class RevisionNotFoundError extends Error {
  readonly entryId: string;
  readonly revisionId: string;

  constructor(entryId: string, revisionId: string) {
    super(
      `@plakboek/content: no revision "${revisionId}" found for entry "${entryId}"`,
    );
    this.name = 'RevisionNotFoundError';
    this.entryId = entryId;
    this.revisionId = revisionId;
  }
}

export type RestorePreview = {
  readonly revisionId: string;
  readonly mappedKeys: readonly {
    readonly from: string;
    readonly to: string;
  }[];
  readonly droppedKeys: readonly string[];
  readonly emptyFields: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly validationIssues: readonly FieldValidationIssue[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ComputeRestorePreviewInput = {
  readonly entryId: string;
  readonly revisionId: string;
};

/**
 * Previews restoring `revisionId` onto `entryId`'s current schema (D-17),
 * without writing anything. For every key the snapshot held: resolves the
 * field id that held it from the snapshot's own `field_ids` map, falling
 * back to walking `content_field_key_history` (matched on the snapshot's
 * key as a former `oldKey`) when the map lacks an entry for it -- a
 * snapshot taken before this plan shipped `field_ids`. A key whose field id
 * no longer names a current field is listed in `droppedKeys` and never
 * carried into the mapped data (D-07: a deleted field's value is never
 * resurrected). A key that resolves to a current field under a *different*
 * key than the snapshot used is listed in `mappedKeys`; a current field the
 * snapshot never held a value for is listed in `emptyFields`. Finally runs
 * `validateEntryData` against the mapped data inside a `try`/`catch`,
 * collecting `FieldValidationError.issues` rather than throwing, so a
 * caller can show every problem before deciding whether to restore.
 * Read-only, and typed to accept a transaction handle too, so
 * `restoreRevision` recomputes this same preview inside its own mutation
 * without drifting from what a caller previewed beforehand.
 */
export async function computeRestorePreview(
  db: AuditDatabase,
  input: ComputeRestorePreviewInput,
): Promise<RestorePreview> {
  const entry = await getEntry(db, input.entryId);
  if (entry === null) {
    throw new EntryNotFoundError(input.entryId);
  }

  const [revisionRow] = await db
    .select()
    .from(entryRevisions)
    .where(eq(entryRevisions.id, input.revisionId))
    .limit(1);
  if (revisionRow === undefined || revisionRow.entryId !== input.entryId) {
    throw new RevisionNotFoundError(input.entryId, input.revisionId);
  }

  const currentFields = await listFields(db, entry.contentTypeId);
  const fieldsById = new Map(currentFields.map((field) => [field.id, field]));

  const keyHistory = await listFieldKeyHistory(db, entry.contentTypeId);
  const fieldIdByOldKey = new Map<string, string>();
  for (const change of keyHistory) {
    if (change.oldKey !== null) {
      fieldIdByOldKey.set(change.oldKey, change.fieldId);
    }
  }

  const snapshotFieldIds: Record<string, unknown> = isPlainObject(
    revisionRow.fieldIds,
  )
    ? revisionRow.fieldIds
    : {};
  const snapshotData: Record<string, unknown> = isPlainObject(revisionRow.data)
    ? revisionRow.data
    : {};

  const mappedKeys: { from: string; to: string }[] = [];
  const droppedKeys: string[] = [];
  const mappedData: Record<string, unknown> = {};
  const mappedFieldIds = new Set<string>();

  for (const snapshotKey of Object.keys(snapshotData)) {
    const snapshotFieldId = snapshotFieldIds[snapshotKey];
    const fieldId =
      typeof snapshotFieldId === 'string'
        ? snapshotFieldId
        : fieldIdByOldKey.get(snapshotKey);
    const currentField =
      fieldId === undefined ? undefined : fieldsById.get(fieldId);

    if (currentField === undefined) {
      droppedKeys.push(snapshotKey);
      continue;
    }

    mappedFieldIds.add(currentField.id);
    mappedData[currentField.key] = snapshotData[snapshotKey];
    if (currentField.key !== snapshotKey) {
      mappedKeys.push({ from: snapshotKey, to: currentField.key });
    }
  }

  const emptyFields = currentFields
    .filter((field) => !mappedFieldIds.has(field.id))
    .map((field) => field.key);

  let validationIssues: readonly FieldValidationIssue[] = [];
  try {
    validateEntryData(currentFields, mappedData);
  } catch (error) {
    if (!(error instanceof FieldValidationError)) throw error;
    validationIssues = error.issues;
  }

  return Object.freeze({
    revisionId: input.revisionId,
    mappedKeys: Object.freeze(mappedKeys),
    droppedKeys: Object.freeze(droppedKeys),
    emptyFields: Object.freeze(emptyFields),
    data: Object.freeze(mappedData),
    validationIssues,
  });
}

export type RestoreRevisionInput = {
  readonly entryId: string;
  readonly baseVersion: number;
  readonly revisionId: string;
};

/**
 * Restores a revision as an ordinary validated save (D-17, T-03-41).
 * Decides the save permission exactly like `saveEntry` does
 * (`decideSavePermission`: `entries:publish` only on a drafts-off,
 * currently-published entry, `entries:edit` otherwise), then -- inside
 * `deps.recorder.run`'s own transaction -- recomputes the restore preview
 * (so a caller's earlier preview and this write can never disagree),
 * refuses with `FieldValidationError` when the mapped data has any
 * validation issue -- writing nothing -- and otherwise replays the mapped
 * data through `saveEntryInTransaction`, the exact same transaction body
 * `saveEntry` runs: drafts, locks, versions and slugs all behave
 * identically to a normal save. The revision row itself is never modified.
 * Runs through `deps.recorder.run` (`entries:edit`/`entries:publish` /
 * `entry.restore-revision`).
 */
export async function restoreRevision(
  deps: ContentDeps,
  actor: AuditActor,
  input: RestoreRevisionInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);
  const permission = await decideSavePermission(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission,
      action: 'entry.restore-revision',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: entrySnapshot(before) }),
    },
    async (tx) => {
      const preview = await computeRestorePreview(tx, {
        entryId: input.entryId,
        revisionId: input.revisionId,
      });
      if (preview.validationIssues.length > 0) {
        throw new FieldValidationError(preview.validationIssues);
      }

      const saved = await saveEntryInTransaction(
        tx,
        deps,
        actor,
        { permission, now },
        {
          entryId: input.entryId,
          baseVersion: input.baseVersion,
          data: preview.data,
        },
      );

      return {
        result: saved.result,
        after: {
          revisionId: input.revisionId,
          mappedKeys: preview.mappedKeys,
          droppedKeys: preview.droppedKeys,
          version: saved.result.version,
        },
      };
    },
  );
}
