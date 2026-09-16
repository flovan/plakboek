/**
 * Publishing an entry (TYPE-04, TYPE-06, TYPE-07, TYPE-09, TYPE-10, D-27,
 * D-29, D-30, D-31, D-33, D-46, D-47): slug enforcement, first-publish
 * freezing, resolved-path materialisation with collision refusal, URL
 * history and pending-draft promotion, all inside one audited mutation.
 * Follows `save.ts`'s contract -- load, check version, lock the type row,
 * check the edit lock, validate, update -- with the working copy (live data,
 * or a pending draft revision when one is staged) taking the place of a
 * save's input data.
 */
import type { AuditActor, AuditDatabase } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { getEntry, loadEntryForUpdate, toEntryRecord } from './entries.js';
import { EntryNotFoundError } from './entries.js';
import { listFields } from './fields.js';
import { assertRowsWritable } from './locks.js';
import {
  assertPathAvailable,
  computeEntryPath,
  recordUrlHistory,
  urlCollisionFromUniqueViolation,
} from './routing.js';
import { StaleVersionError } from './save.js';
import { contentEntries, contentTypes, entryRevisions } from './schema.js';
import {
  generateUniqueEntrySlug,
  slugConflictFromUniqueViolation,
} from './slug.js';
import { validateEntrySeo, type EntrySeo } from './seo.js';
import type { EntryRecord } from './types.js';
import { validateEntryData } from './validation.js';

/** Thrown when a routable entry's working copy has no usable slug at
 * publish time (D-29): `slug` is `null`, empty, or whitespace-only, and no
 * generated slug could take its place. */
export class SlugRequiredError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(
      `@plakboek/content: entry "${entryId}" needs a slug before it can be published`,
    );
    this.name = 'SlugRequiredError';
    this.entryId = entryId;
  }
}

/** Thrown when an entry's status or its content type's `drafts` setting no
 * longer matches the permission decision made for it before the audited
 * mutation opened -- a race between that decision and the row's `FOR UPDATE`
 * reload, not a permission problem. `save.ts` throws this from its own
 * permission-branch reload; defined here so both modules share one shape. */
export class EntryStateChangedError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(
      `@plakboek/content: entry "${entryId}" changed state while the request was being handled`,
    );
    this.name = 'EntryStateChangedError';
    this.entryId = entryId;
  }
}

export type WorkingCopy = {
  readonly entry: EntryRecord;
  readonly data: unknown;
  readonly seo: unknown;
  readonly slug: string | null;
  readonly pendingRevisionId: string | null;
};

/**
 * Reads one entry's working copy (D-47): the pending draft revision's
 * `data`, `seo` and `slug` when `draft_revision_id` is set, otherwise the
 * row's own live values. Throws `EntryNotFoundError` when the entry itself
 * doesn't exist, or a defensive `Error` when a set `draft_revision_id`
 * points at a revision row that is gone (never expected -- revisions are
 * only ever replaced or deleted by the same code that clears the pointer).
 */
export async function readWorkingCopy(
  db: AuditDatabase,
  entryId: string,
): Promise<WorkingCopy> {
  const entry = await getEntry(db, entryId);
  if (entry === null) {
    throw new EntryNotFoundError(entryId);
  }
  if (entry.draftRevisionId === null) {
    return {
      entry,
      data: entry.data,
      seo: entry.seo,
      slug: entry.slug,
      pendingRevisionId: null,
    };
  }

  const [revision] = await db
    .select({
      data: entryRevisions.data,
      seo: entryRevisions.seo,
      slug: entryRevisions.slug,
    })
    .from(entryRevisions)
    .where(eq(entryRevisions.id, entry.draftRevisionId))
    .limit(1);
  if (revision === undefined) {
    throw new Error(
      `@plakboek/content: entry "${entryId}" references a missing pending revision "${entry.draftRevisionId}"`,
    );
  }
  return {
    entry,
    data: revision.data,
    seo: revision.seo,
    slug: revision.slug,
    pendingRevisionId: entry.draftRevisionId,
  };
}

function isBlankSlug(slug: string | null): boolean {
  return slug === null || slug.trim().length === 0;
}

function beforeSnapshot(entry: EntryRecord) {
  return {
    version: entry.version,
    status: entry.status,
    slug: entry.slug,
    resolvedPath: entry.resolvedPath,
    data: entry.data,
  };
}

export type PublishEntryInput = {
  readonly entryId: string;
  readonly baseVersion: number;
};

/**
 * Publishes an entry (TYPE-04, TYPE-06, TYPE-07, TYPE-09, D-27, D-29, D-30,
 * D-31, D-33, D-46, D-47). Loads and locks the row (`FOR UPDATE`), checks its
 * version against `input.baseVersion` (D-42), locks the type row (`FOR
 * SHARE`) and checks the edit lock (`assertRowsWritable`), then takes the
 * working copy and validates its `data` (FIELD-06, D-12) and, when staged,
 * its `seo` (D-46) against the content type's *current* fields and SEO
 * setting -- so a pending draft that no longer satisfies the schema can no
 * more go live than pending SEO that breaks its rules can.
 *
 * On a routable, never-published entry with an empty slug and a title field
 * configured, generates one from the working copy's title value
 * (`generateUniqueEntrySlug`); a routable entry still without a usable slug
 * throws `SlugRequiredError`. `first_published_at` is set to now only when
 * it is still `null` (D-30 -- republishing never moves it), and the
 * resolved path is computed from it, refusing a collision
 * (`assertPathAvailable`, backstopped by the partial unique index) and
 * recording URL history when a previously published path is moving (D-33).
 * One `UPDATE` promotes the working copy to the live row and clears
 * `draft_revision_id`; the previously pending revision row is deleted once
 * nothing points to it, when the content type has revisions disabled. Runs
 * through `deps.recorder.run` (`entries:publish` / `entry.publish`).
 */
export async function publishEntry(
  deps: ContentDeps,
  actor: AuditActor,
  input: PublishEntryInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:publish',
      action: 'entry.publish',
      entityType: 'content_entry',
      entityId: input.entryId,
      ...(before === null ? {} : { before: beforeSnapshot(before) }),
    },
    async (tx) => {
      // loadEntryForUpdate both confirms the entry exists and locks the row
      // FOR UPDATE for the duration of this transaction (D-42/D-47).
      const current = await loadEntryForUpdate(tx, input.entryId);

      if (current.version !== input.baseVersion) {
        throw new StaleVersionError(
          input.entryId,
          input.baseVersion,
          current.version,
        );
      }

      // Locks the type row for the duration of the publish, so a concurrent
      // field delete/rename can't remove a field this publish is about to
      // validate against mid-transaction.
      const [type] = await tx
        .select({
          id: contentTypes.id,
          routable: contentTypes.routable,
          urlPattern: contentTypes.urlPattern,
          titleFieldKey: contentTypes.titleFieldKey,
          seo: contentTypes.seo,
          revisions: contentTypes.revisions,
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

      assertRowsWritable([current], type, actor.userId, now());

      const fields = await listFields(tx, current.contentTypeId);
      const workingCopy = await readWorkingCopy(tx, input.entryId);

      const validatedData = validateEntryData(fields, workingCopy.data);

      let seo: EntrySeo | null = null;
      if (workingCopy.seo !== null && workingCopy.seo !== undefined) {
        seo = validateEntrySeo(workingCopy.seo, { seoEnabled: type.seo });
      }

      let slug = workingCopy.slug;
      const neverPublished = current.firstPublishedAt === null;

      if (type.routable) {
        if (
          neverPublished &&
          isBlankSlug(slug) &&
          type.titleFieldKey !== null
        ) {
          const titleValue = validatedData[type.titleFieldKey];
          if (typeof titleValue === 'string' && titleValue.trim().length > 0) {
            slug = await generateUniqueEntrySlug(tx, {
              contentTypeId: current.contentTypeId,
              locale: current.locale,
              base: titleValue,
              excludeEntryId: current.id,
            });
          }
        }
        if (isBlankSlug(slug)) {
          throw new SlugRequiredError(current.id);
        }
      }

      const publishedAt = now();
      const firstPublishedAt = current.firstPublishedAt ?? publishedAt;

      const path = computeEntryPath(
        type,
        { slug, publicId: current.publicId, firstPublishedAt },
        deps.config.timezone,
      );

      const previousPath = current.resolvedPath;
      if (previousPath !== null && path !== previousPath) {
        await recordUrlHistory(tx, {
          entryId: current.id,
          contentTypeId: current.contentTypeId,
          translationGroup: current.translationGroup,
          locale: current.locale,
          oldPath: previousPath,
          reason: 'slug_changed',
          changedAt: publishedAt,
        });
      }

      if (path !== null) {
        await assertPathAvailable(tx, {
          path,
          locale: current.locale,
          entryId: current.id,
        });
      }

      let row: typeof contentEntries.$inferSelect | undefined;
      try {
        [row] = await tx
          .update(contentEntries)
          .set({
            data: validatedData,
            seo,
            slug,
            status: 'published',
            publishedAt,
            firstPublishedAt,
            resolvedPath: path,
            scheduledAt: null,
            draftRevisionId: null,
            version: sql`${contentEntries.version} + 1`,
            updatedAt: publishedAt,
            updatedBy: actor.userId,
          })
          .where(
            and(
              eq(contentEntries.id, input.entryId),
              eq(contentEntries.version, input.baseVersion),
            ),
          )
          .returning();
      } catch (error) {
        if (path !== null) {
          const urlCollision = urlCollisionFromUniqueViolation(error, {
            path,
            locale: current.locale,
          });
          if (urlCollision !== undefined) throw urlCollision;
        }
        if (slug !== null) {
          const slugConflict = slugConflictFromUniqueViolation(error, {
            slug,
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

      // The previously pending revision is only ever deleted here when the
      // type has revisions disabled -- with revisions on, plan 03-09 keeps
      // it as history.
      if (!type.revisions && workingCopy.pendingRevisionId !== null) {
        await tx
          .delete(entryRevisions)
          .where(eq(entryRevisions.id, workingCopy.pendingRevisionId));
      }

      const record = toEntryRecord(row);
      return {
        result: record,
        after: {
          version: record.version,
          status: record.status,
          slug: record.slug,
          resolvedPath: record.resolvedPath,
          data: record.data,
        },
      };
    },
  );
}
