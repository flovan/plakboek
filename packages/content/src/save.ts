/**
 * Version-checked, lock-checked, validated, audited entry saves (D-42, D-43,
 * D-45, D-12), plus D-11/D-47's draft-versus-live split, D-27/D-28's
 * title-driven slug generation up to first publish, and D-46's SEO writer.
 * Every save carries the version it started from; a stale save changes
 * nothing. This module's structure -- decide the permission, load, check
 * version, lock the type row, re-verify the permission decision, check the
 * edit lock, validate, update -- is the contract plans 03-06, 03-07, 03-09
 * and 03-10 extend.
 *
 * D-11/D-47: on a type with drafts enabled, saving an already-published (or
 * scheduled) entry stages the change as a pending draft revision and leaves
 * the live row untouched apart from its `draft_revision_id` pointer; on a
 * type with drafts disabled, or an entry never published, a save is live and
 * requires `entries:publish` in the drafts-off-and-published case (D-11).
 * The permission is decided from an unlocked read before the audited
 * mutation opens (so `deps.recorder.run`'s permission check runs against
 * the same decision), then re-verified against the `FOR UPDATE` reload
 * inside the mutation -- a status or `drafts` change in between throws
 * `EntryStateChangedError`, never silently switching which permission gated
 * the write.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { Permission } from '@plakboek/permissions';
import type { ContentDeps } from './config.js';
import {
  getEntry,
  lockTranslationGroupForUpdate,
  toEntryRecord,
} from './entries.js';
import { listFields } from './fields.js';
import { assertRowsWritable } from './locks.js';
import { EntryStateChangedError, readWorkingCopy } from './publish.js';
import {
  assertReferencesResolvable,
  syncEntryReferenceIndex,
} from './references.js';
import { pruneSaveRevisions, recordRevision } from './revisions.js';
import {
  assertPathAvailable,
  computeEntryPath,
  recordUrlHistory,
  urlCollisionFromUniqueViolation,
} from './routing.js';
import { contentEntries, contentTypes, entryRevisions } from './schema.js';
import { getRevisionCap } from './settings.js';
import {
  assertEntrySlugAvailable,
  generateUniqueEntrySlug,
  InvalidSlugError,
  slugConflictFromUniqueViolation,
  SlugGenerationError,
} from './slug.js';
import { validateEntrySeo, type EntrySeo } from './seo.js';
import type { EntryRecord, FieldDefinition } from './types.js';
import { validateEntryData } from './validation.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON-safe (jsonb-compatible) values: two
 * `undefined`s are equal (both "no value"), any other mismatched pair
 * involving `undefined` is not (D-19/D-23/D-26 treat a value going missing
 * as a real change), and everything else compares by serialized shape so
 * key order in an object never produces a false "changed". */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** The subset of a content type row `applySyncedFieldChanges` needs -- a
 * plain `string | null` for `revisionMode` (not the narrower `RevisionMode`
 * union) since every caller already holds it as a raw column read and the
 * function only ever compares it by string equality. */
export type SyncableContentType = {
  readonly drafts: boolean;
  readonly revisions: boolean;
  readonly revisionMode: string | null;
};

export type ApplySyncedFieldChangesInput = {
  readonly row: EntryRecord;
  readonly type: SyncableContentType;
  readonly fields: readonly FieldDefinition[];
  /** Key -> new value, for exactly the keys this row's own working copy
   * should now hold; `applySyncedFieldChanges` reads the row's current
   * working copy itself and merges `changes` on top of it. */
  readonly changes: Readonly<Record<string, unknown>>;
  readonly authorId: string | null;
  readonly now: Date;
};

/**
 * Applies `changes` onto one row's own working copy through the same
 * draft-or-live branch an ordinary save uses (D-19, D-23, D-26): when the
 * type has drafts on and the row is `published` or `scheduled`, the merged
 * data is staged as a new pending `save` revision (the previous pending
 * revision is deleted once nothing points to it, per D-13); otherwise the
 * merged data is written live, recording a `publish` revision when the row
 * is already published (a live write to published data is itself a publish
 * event, matching a live save's own D-13 rule) or a `save` revision in
 * `on_every_save` mode for a not-yet-published row. Bumps the row's
 * `version` and `updated_at`; the caller prunes `save`-kind revisions
 * afterward. Returns `false` (writing nothing) when every one of `changes`
 * already matches the row's current working copy -- a no-op sync leaves the
 * row's version untouched (D-23's "a group whose rows already agree is not
 * rewritten"). Exported so `field-translatable.ts`'s translatable toggle
 * applies its winner value to a differing row the same way
 * `saveEntryInTransaction` syncs a shared field across a translation group.
 */
export async function applySyncedFieldChanges(
  tx: AuditTransaction,
  input: ApplySyncedFieldChangesInput,
): Promise<boolean> {
  const { row, type, fields, changes, authorId, now } = input;
  const workingCopy = await readWorkingCopy(tx, row.id);
  const workingData = isPlainObject(workingCopy.data) ? workingCopy.data : {};

  const changedEntries = Object.entries(changes).filter(
    ([key, value]) => !valuesEqual(value, workingData[key]),
  );
  if (changedEntries.length === 0) return false;

  const mergedData: Record<string, unknown> = { ...workingData, ...changes };

  const isPendingDraftBranch =
    type.drafts && (row.status === 'published' || row.status === 'scheduled');

  if (isPendingDraftBranch) {
    const revisionId = await recordRevision(tx, {
      entryId: row.id,
      locale: row.locale,
      kind: 'save',
      data: mergedData,
      seo: workingCopy.seo,
      slug: workingCopy.slug,
      fields,
      authorId,
      createdAt: now,
    });
    const previousPendingId = row.draftRevisionId;
    await tx
      .update(contentEntries)
      .set({
        draftRevisionId: revisionId,
        version: sql`${contentEntries.version} + 1`,
        updatedAt: now,
        updatedBy: authorId,
      })
      .where(eq(contentEntries.id, row.id));

    if (
      previousPendingId !== null &&
      (!type.revisions || type.revisionMode === 'on_publish')
    ) {
      await tx
        .delete(entryRevisions)
        .where(eq(entryRevisions.id, previousPendingId));
    }
    return true;
  }

  let liveRevisionId: string | null = null;
  if (row.status === 'published' && type.revisions) {
    liveRevisionId = await recordRevision(tx, {
      entryId: row.id,
      locale: row.locale,
      kind: 'publish',
      data: mergedData,
      seo: workingCopy.seo,
      slug: workingCopy.slug,
      fields,
      authorId,
      createdAt: now,
    });
  } else if (type.revisions && type.revisionMode === 'on_every_save') {
    await recordRevision(tx, {
      entryId: row.id,
      locale: row.locale,
      kind: 'save',
      data: mergedData,
      seo: workingCopy.seo,
      slug: workingCopy.slug,
      fields,
      authorId,
      createdAt: now,
    });
  }

  await tx
    .update(contentEntries)
    .set({
      data: mergedData,
      version: sql`${contentEntries.version} + 1`,
      updatedAt: now,
      updatedBy: authorId,
      ...(liveRevisionId !== null ? { liveRevisionId } : {}),
    })
    .where(eq(contentEntries.id, row.id));

  // D-40: this row's data just changed live, so its reference index must
  // be rebuilt too -- a shared reference field synced to a sibling (or a
  // translatable toggle's winner value, field-translatable.ts's own caller
  // of this function) is exactly as live-writing as an origin's own save.
  await syncEntryReferenceIndex(tx, {
    entryId: row.id,
    fields,
    data: mergedData,
  });
  return true;
}

export type SaveEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
  readonly data: unknown;
  /** A string is a hand-typed slug (`slug_source` becomes `'manual'`);
   * `null` clears a manual slug so generation resumes before first publish;
   * omitted leaves the slug alone (regenerating it from the title only
   * while unpublished and not hand-typed). Rejected with `InvalidSlugError`
   * on a non-routable type. */
  readonly slug?: string | null;
  /** Omitted leaves the stored SEO value alone; a value is validated with
   * `validateEntrySeo` and stored complete (D-46). */
  readonly seo?: unknown;
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

/** Exported so `revisions.ts`'s `restoreRevision` can build the same
 * `before`/`after` audit shape a normal save uses. */
export function entrySnapshot(entry: EntryRecord) {
  return {
    version: entry.version,
    status: entry.status,
    slug: entry.slug,
    resolvedPath: entry.resolvedPath,
    draftRevisionId: entry.draftRevisionId,
    data: entry.data,
  };
}

type SlugSource = 'generated' | 'manual' | null;

function asSlugSource(value: string | null): SlugSource {
  return value === 'generated' || value === 'manual' ? value : null;
}

/**
 * Decides which permission gates this save, from an unlocked read (D-11):
 * `entries:publish` only when the type has drafts disabled and the row is
 * currently `published`, `entries:edit` otherwise. A missing entry defaults
 * to `entries:edit` -- the mutation's own `lockTranslationGroupForUpdate`
 * throws `EntryNotFoundError` for that case regardless of which permission
 * was checked. Exported so `revisions.ts`'s `restoreRevision` decides its
 * own permission the same way an ordinary save does.
 */
export async function decideSavePermission(
  db: AuditDatabase,
  entryId: string,
): Promise<Permission> {
  const [row] = await db
    .select({ status: contentEntries.status, drafts: contentTypes.drafts })
    .from(contentEntries)
    .innerJoin(contentTypes, eq(contentEntries.contentTypeId, contentTypes.id))
    .where(eq(contentEntries.id, entryId))
    .limit(1);
  if (row === undefined) return 'entries:edit';
  return !row.drafts && row.status === 'published'
    ? 'entries:publish'
    : 'entries:edit';
}

type SlugResolutionType = {
  readonly routable: boolean;
  readonly titleFieldKey: string | null;
};

type SlugResolutionCurrent = {
  readonly id: string;
  readonly contentTypeId: string;
  readonly locale: string;
  readonly slug: string | null;
  readonly slugSource: SlugSource;
  readonly firstPublishedAt: Date | null;
};

/**
 * Resolves the slug/slugSource a save should write (D-27, D-28). A
 * non-routable type rejects any `inputSlug` (including an explicit `null`)
 * with `InvalidSlugError`. `null` clears a manual slug. A string must pass
 * `assertEntrySlugAvailable` and becomes `'manual'`. Omitted regenerates
 * from the type's title field only while the current slug isn't hand-typed
 * and the entry has never been published (D-27's freeze) -- a title that
 * normalises to nothing leaves the slug `null` rather than failing the save.
 */
async function resolveSlug(
  tx: AuditTransaction,
  type: SlugResolutionType,
  current: SlugResolutionCurrent,
  inputSlug: string | null | undefined,
  validatedData: Readonly<Record<string, unknown>>,
): Promise<{ readonly slug: string | null; readonly slugSource: SlugSource }> {
  if (!type.routable) {
    if (inputSlug !== undefined) {
      throw new InvalidSlugError(inputSlug ?? '', '');
    }
    return { slug: current.slug, slugSource: current.slugSource };
  }

  if (inputSlug === null) {
    return { slug: null, slugSource: null };
  }
  if (inputSlug !== undefined) {
    await assertEntrySlugAvailable(tx, {
      contentTypeId: current.contentTypeId,
      locale: current.locale,
      slug: inputSlug,
      excludeEntryId: current.id,
    });
    return { slug: inputSlug, slugSource: 'manual' };
  }

  // inputSlug omitted: regenerate only while not hand-typed and unpublished.
  if (current.slugSource === 'manual' || current.firstPublishedAt !== null) {
    return { slug: current.slug, slugSource: current.slugSource };
  }
  if (type.titleFieldKey === null) {
    return { slug: current.slug, slugSource: current.slugSource };
  }

  const titleValue = validatedData[type.titleFieldKey];
  const base = typeof titleValue === 'string' ? titleValue : '';
  try {
    const generated = await generateUniqueEntrySlug(tx, {
      contentTypeId: current.contentTypeId,
      locale: current.locale,
      base,
      excludeEntryId: current.id,
    });
    return { slug: generated, slugSource: 'generated' };
  } catch (error) {
    if (error instanceof SlugGenerationError) {
      return { slug: null, slugSource: null };
    }
    throw error;
  }
}

export type SaveEntryContext = {
  /** The permission `saveEntry` decided from an unlocked read before its
   * own transaction opened -- re-verified here against the freshly locked
   * row (D-11). */
  readonly permission: Permission;
  readonly now: () => Date;
};

export type SaveEntryTransactionResult = {
  readonly result: EntryRecord;
  readonly after: unknown;
};

/**
 * The transaction body every save runs (D-11, D-12, D-27, D-28, D-42, D-43,
 * D-45, D-46, D-47, D-13). Exported so `revisions.ts`'s `restoreRevision`
 * replays a mapped revision through the exact same rules an ordinary save
 * follows -- drafts, locks, versions, slugs and validation all behave
 * identically whether the caller is `saveEntry` or a restore.
 *
 * Loads and locks the row (`FOR UPDATE`), checks its version against
 * `input.baseVersion` (D-42), loads and locks the type row (`FOR SHARE`),
 * re-verifies `context.permission` against the freshly locked row
 * (`EntryStateChangedError` on a mismatch -- e.g. the row was published in
 * the gap), checks the edit lock (`assertRowsWritable`), then validates
 * `data` (FIELD-06, D-12) and, when present, `seo` (D-46) against the
 * content type's current fields and SEO setting, resolves the slug
 * (`resolveSlug`), and writes:
 *
 * - **Pending draft** (drafts enabled, row `published` or `scheduled`,
 *   D-47): records a new `entry_revisions` row of kind `save`
 *   (`recordRevision`) holding the validated data/SEO/slug, points
 *   `draft_revision_id` at it, bumps `version`. Live `data`, `seo`, `slug`
 *   and `resolved_path` are untouched. The previously pending row is
 *   deleted once nothing points to it, when the type has revisions
 *   disabled or is in `on_publish` mode (D-13 keeps it as history in
 *   `on_every_save` mode).
 * - **Live** (never published, or drafts disabled): updates `data`, `slug`,
 *   `slugSource` directly, `seo` only when the input carried one. When the
 *   row is `published` and the resolved path changes, records URL history
 *   (D-33) and refuses a collision (`assertPathAvailable`, backstopped by
 *   the unique-violation mapping). A live save of an already-published
 *   entry (only reachable on a drafts-off type, D-11) records a `publish`
 *   revision and moves `live_revision_id` -- the data becoming live *is* a
 *   publish event, regardless of the type's revision mode; an entry not yet
 *   published records a `save` revision instead, but only in
 *   `on_every_save` mode. After either branch, `save`-kind history is
 *   pruned to the project-wide cap (D-14, D-16); `publish`-kind rows are
 *   never touched by this.
 */
export async function saveEntryInTransaction(
  tx: AuditTransaction,
  deps: ContentDeps,
  actor: AuditActor,
  context: SaveEntryContext,
  input: SaveEntryInput,
): Promise<SaveEntryTransactionResult> {
  const { permission, now } = context;

  // lockTranslationGroupForUpdate both confirms the entry exists
  // (EntryNotFoundError otherwise) and locks every row of its translation
  // group, in locale order, for the duration of this transaction (plan
  // 03-10) -- so the explicit version check below and the final UPDATE's
  // WHERE clause can never disagree with each other, and a shared-field
  // sync below never races a sibling's own concurrent save.
  const { origin: current, rows: groupRows } =
    await lockTranslationGroupForUpdate(tx, deps.config, input.entryId);

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
  // validate against mid-transaction; also carries every setting the
  // rest of this mutation needs.
  const [type] = await tx
    .select({
      id: contentTypes.id,
      routable: contentTypes.routable,
      urlPattern: contentTypes.urlPattern,
      titleFieldKey: contentTypes.titleFieldKey,
      seo: contentTypes.seo,
      drafts: contentTypes.drafts,
      revisions: contentTypes.revisions,
      revisionMode: contentTypes.revisionMode,
      editLocking: contentTypes.editLocking,
    })
    .from(contentTypes)
    .where(eq(contentTypes.id, current.contentTypeId))
    .for('share');
  if (type === undefined) {
    throw new Error(
      `@plakboek/content: no content type found for entry "${input.entryId}"`,
    );
  }

  // The permission decided before this mutation opened must still hold
  // against the freshly locked row (D-11): a status/drafts change in
  // the gap (e.g. someone else just published it) is a race, not a
  // permission problem -- the caller retries.
  const decidedPublishBranch = permission === 'entries:publish';
  const actualPublishBranch = !type.drafts && current.status === 'published';
  if (decidedPublishBranch !== actualPublishBranch) {
    throw new EntryStateChangedError(input.entryId);
  }

  // Lock check second (D-43/D-45): refuses when another user holds a
  // live lock on this row; a no-op when the type has no edit locking.
  assertRowsWritable([current], type, actor.userId, now());

  const fields = await listFields(tx, current.contentTypeId);
  const validatedData = validateEntryData(fields, input.data);

  // T-03-61/FIELD-06/D-12: a reference value must name a real target of an
  // allowed type before anything is written -- runs for both the
  // pending-draft and live branches below, so an unresolvable reference
  // can never even be staged.
  await assertReferencesResolvable(tx, fields, validatedData);

  // D-19/D-26: a non-translatable field's value is shared by every row of
  // the translation group. Diff against the origin's own working copy (its
  // pending draft when one is staged, its live data otherwise) -- not just
  // its live `data` column -- so a value staged in a prior save is the
  // baseline a new save is compared against. A value going missing counts
  // as a change too (`valuesEqual` treats one side being `undefined` as
  // unequal, unless both are).
  const originWorkingCopy = await readWorkingCopy(tx, current.id);
  const originWorkingData = isPlainObject(originWorkingCopy.data)
    ? originWorkingCopy.data
    : {};
  const nonTranslatableKeys = fields
    .filter((field) => !field.translatable)
    .map((field) => field.key);
  const changedSharedKeys = nonTranslatableKeys.filter(
    (key) => !valuesEqual(validatedData[key], originWorkingData[key]),
  );

  // Rows whose locale was removed from ContentConfig are left untouched by
  // shared-field sync (D-25) -- they are simply excluded from the sibling
  // set below, never read or written by this save.
  const siblings = groupRows.filter(
    (row) => row.id !== current.id && deps.config.locales.includes(row.locale),
  );

  // D-45: refuses this save on the first sibling holding a live lock by
  // someone else, before any row -- origin included -- is written, whenever
  // a shared value is about to change. A save touching only translatable
  // fields never reaches this check, so a locked sibling never blocks it.
  if (changedSharedKeys.length > 0) {
    assertRowsWritable(siblings, type, actor.userId, now());
  }

  let validatedSeo: EntrySeo | undefined;
  if (input.seo !== undefined) {
    validatedSeo = validateEntrySeo(input.seo, { seoEnabled: type.seo });
  }

  const [slugSourceRow] = await tx
    .select({ slugSource: contentEntries.slugSource })
    .from(contentEntries)
    .where(eq(contentEntries.id, input.entryId))
    .limit(1);

  const { slug: resolvedSlug, slugSource: resolvedSlugSource } =
    await resolveSlug(
      tx,
      type,
      {
        id: current.id,
        contentTypeId: current.contentTypeId,
        locale: current.locale,
        // Same rule as `stagedSeo` below. A slug staged on a pending draft
        // is the baseline an omitted `slug` falls back to, not the live
        // row's. Identical to `current.slug` when no draft is pending.
        slug: originWorkingCopy.slug,
        slugSource: asSlugSource(slugSourceRow?.slugSource ?? null),
        firstPublishedAt: current.firstPublishedAt,
      },
      input.slug,
      validatedData,
    );

  const updatedAt = now();
  const isPendingDraftBranch =
    type.drafts &&
    (current.status === 'published' || current.status === 'scheduled');

  let row: typeof contentEntries.$inferSelect | undefined;

  if (isPendingDraftBranch) {
    // An omitted `seo` keeps the working copy's own staged value, not the
    // live row's. Autosave sends only what changed, so a save that omits
    // `seo` must not revert an SEO edit staged by an earlier save.
    // `originWorkingCopy` is the pending draft when one is staged and the
    // live row otherwise, so this is identical to `current.seo` whenever no
    // draft is pending.
    const stagedSeo =
      input.seo !== undefined ? validatedSeo : originWorkingCopy.seo;

    const revisionId = await recordRevision(tx, {
      entryId: current.id,
      locale: current.locale,
      kind: 'save',
      data: validatedData,
      seo: stagedSeo,
      slug: resolvedSlug,
      fields,
      authorId: actor.userId,
      createdAt: updatedAt,
    });

    const previousPendingId = current.draftRevisionId;

    [row] = await tx
      .update(contentEntries)
      .set({
        draftRevisionId: revisionId,
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

    // Replaces (never accumulates) the previous pending row once revisions
    // are disabled, or in on_publish mode -- D-13 keeps it as history in
    // on_every_save mode.
    if (
      previousPendingId !== null &&
      (!type.revisions || type.revisionMode === 'on_publish')
    ) {
      await tx
        .delete(entryRevisions)
        .where(eq(entryRevisions.id, previousPendingId));
    }
  } else {
    let path: string | null = current.resolvedPath;
    if (current.status === 'published') {
      path = computeEntryPath(
        type,
        {
          slug: resolvedSlug,
          publicId: current.publicId,
          firstPublishedAt: current.firstPublishedAt,
        },
        deps.config.timezone,
      );
      if (path !== current.resolvedPath) {
        if (current.resolvedPath !== null) {
          await recordUrlHistory(tx, {
            entryId: current.id,
            contentTypeId: current.contentTypeId,
            translationGroup: current.translationGroup,
            locale: current.locale,
            oldPath: current.resolvedPath,
            reason: 'slug_changed',
            changedAt: updatedAt,
          });
        }
        if (path !== null) {
          await assertPathAvailable(tx, {
            path,
            locale: current.locale,
            entryId: current.id,
          });
        }
      }
    }

    // A live write of already-published data (only reachable on a
    // drafts-off type, D-11) is itself a publish event, regardless of the
    // type's revision mode -- record a `publish` revision and move
    // `live_revision_id`. Otherwise, an entry not yet published records a
    // `save` revision, but only in `on_every_save` mode (D-13); on_publish
    // mode writes nothing until the entry is actually published.
    const effectiveSeo = input.seo !== undefined ? validatedSeo : current.seo;
    let liveRevisionId: string | null = null;
    if (current.status === 'published' && type.revisions) {
      liveRevisionId = await recordRevision(tx, {
        entryId: current.id,
        locale: current.locale,
        kind: 'publish',
        data: validatedData,
        seo: effectiveSeo,
        slug: resolvedSlug,
        fields,
        authorId: actor.userId,
        createdAt: updatedAt,
      });
    } else if (type.revisions && type.revisionMode === 'on_every_save') {
      await recordRevision(tx, {
        entryId: current.id,
        locale: current.locale,
        kind: 'save',
        data: validatedData,
        seo: effectiveSeo,
        slug: resolvedSlug,
        fields,
        authorId: actor.userId,
        createdAt: updatedAt,
      });
    }

    try {
      [row] = await tx
        .update(contentEntries)
        .set({
          data: validatedData,
          slug: resolvedSlug,
          slugSource: resolvedSlugSource,
          version: sql`${contentEntries.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
          ...(input.seo !== undefined ? { seo: validatedSeo } : {}),
          ...(current.status === 'published' ? { resolvedPath: path } : {}),
          ...(liveRevisionId !== null ? { liveRevisionId } : {}),
        })
        .where(
          and(
            eq(contentEntries.id, input.entryId),
            eq(contentEntries.version, input.baseVersion),
          ),
        )
        .returning();
    } catch (error) {
      if (path !== null && current.status === 'published') {
        const urlCollision = urlCollisionFromUniqueViolation(error, {
          path,
          locale: current.locale,
        });
        if (urlCollision !== undefined) throw urlCollision;
      }
      if (resolvedSlug !== null) {
        const slugConflict = slugConflictFromUniqueViolation(error, {
          slug: resolvedSlug,
          locale: current.locale,
          contentTypeId: current.contentTypeId,
        });
        if (slugConflict !== undefined) throw slugConflict;
      }
      throw error;
    }
    if (row === undefined) {
      throw new StaleVersionError(
        input.entryId,
        input.baseVersion,
        current.version,
      );
    }

    // D-40: this is the live branch -- the entry's data just went live, so
    // its reference index must mirror it now. The pending-draft branch
    // above never reaches here: the index tracks the live side only.
    await syncEntryReferenceIndex(tx, {
      entryId: current.id,
      fields,
      data: validatedData,
    });
  }

  const revisionCap = await getRevisionCap(tx);

  // D-14/D-16: `save`-kind history is bounded to the project-wide cap after
  // every save, whichever branch ran above -- a no-op query when the cap is
  // 0 (uncapped) or this entry's type never writes `save`-kind rows.
  await pruneSaveRevisions(tx, {
    cap: revisionCap,
    entryId: current.id,
  });

  // D-19/D-26: propagate every changed shared value to every enabled
  // sibling of the group, each through its own draft-or-live branch
  // (`applySyncedFieldChanges`) -- a sibling whose working copy already
  // holds the new value is left untouched (no version bump, no revision).
  const syncedLocales: string[] = [];
  if (changedSharedKeys.length > 0) {
    const changes: Record<string, unknown> = {};
    for (const key of changedSharedKeys) {
      changes[key] = validatedData[key];
    }
    for (const sibling of siblings) {
      const wrote = await applySyncedFieldChanges(tx, {
        row: sibling,
        type,
        fields,
        changes,
        authorId: actor.userId,
        now: updatedAt,
      });
      if (wrote) {
        syncedLocales.push(sibling.locale);
        await pruneSaveRevisions(tx, { cap: revisionCap, entryId: sibling.id });
      }
    }
  }

  const record = toEntryRecord(row);
  const after =
    changedSharedKeys.length > 0
      ? {
          ...entrySnapshot(record),
          originLocale: current.locale,
          syncedLocales,
        }
      : entrySnapshot(record);

  return {
    result: record,
    after,
  };
}

/**
 * Saves an entry (D-11, D-12, D-27, D-28, D-42, D-43, D-45, D-46, D-47,
 * D-13). Decides the permission from an unlocked read (D-11), then runs
 * `saveEntryInTransaction` inside `deps.recorder.run` (`entries:edit` or
 * `entries:publish` / `entry.save`). See `saveEntryInTransaction` for the
 * full write contract.
 */
export async function saveEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: SaveEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);
  const permission = await decideSavePermission(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission,
      action: 'entry.save',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: entrySnapshot(before) }),
    },
    (tx) => saveEntryInTransaction(tx, deps, actor, { permission, now }, input),
  );
}
