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
import { getEntry, loadEntryForUpdate, toEntryRecord } from './entries.js';
import { listFields } from './fields.js';
import { assertRowsWritable } from './locks.js';
import { EntryStateChangedError } from './publish.js';
import {
  assertPathAvailable,
  computeEntryPath,
  recordUrlHistory,
  urlCollisionFromUniqueViolation,
} from './routing.js';
import { contentEntries, contentTypes, entryRevisions } from './schema.js';
import {
  assertEntrySlugAvailable,
  generateUniqueEntrySlug,
  InvalidSlugError,
  slugConflictFromUniqueViolation,
  SlugGenerationError,
} from './slug.js';
import { validateEntrySeo, type EntrySeo } from './seo.js';
import type { EntryRecord } from './types.js';
import { validateEntryData } from './validation.js';

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

function entrySnapshot(entry: EntryRecord) {
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
 * to `entries:edit` -- the mutation's own `loadEntryForUpdate` throws
 * `EntryNotFoundError` for that case regardless of which permission was
 * checked.
 */
async function decideSavePermission(
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

/**
 * Saves an entry (D-11, D-12, D-27, D-28, D-42, D-43, D-45, D-46, D-47).
 * Loads and locks its row (`FOR UPDATE`), checks its version against
 * `input.baseVersion` (D-42), loads and locks the type row (`FOR SHARE`),
 * re-verifies the permission decided before this mutation opened
 * (`EntryStateChangedError` on a mismatch -- e.g. the row was published in
 * the gap), checks the edit lock (`assertRowsWritable`), then validates
 * `data` (FIELD-06, D-12) and, when present, `seo` (D-46) against the
 * content type's current fields and SEO setting, resolves the slug
 * (`resolveSlug`), and writes:
 *
 * - **Pending draft** (drafts enabled, row `published` or `scheduled`,
 *   D-47): inserts a new `entry_revisions` row of kind `save` holding the
 *   validated data/SEO/slug, points `draft_revision_id` at it, bumps
 *   `version`. Live `data`, `seo`, `slug` and `resolved_path` are untouched.
 *   The previously pending row is deleted once nothing points to it, when
 *   the type has revisions disabled or is in `on_publish` mode (plan 03-09
 *   keeps it as history in `on_every_save` mode).
 * - **Live** (never published, or drafts disabled): updates `data`, `slug`,
 *   `slugSource` directly, `seo` only when the input carried one. When the
 *   row is `published` and the resolved path changes, records URL history
 *   (D-33) and refuses a collision (`assertPathAvailable`, backstopped by
 *   the unique-violation mapping).
 *
 * Runs through `deps.recorder.run` (`entries:edit` or `entries:publish` /
 * `entry.save`).
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
      const actualPublishBranch =
        !type.drafts && current.status === 'published';
      if (decidedPublishBranch !== actualPublishBranch) {
        throw new EntryStateChangedError(input.entryId);
      }

      // Lock check second (D-43/D-45): refuses when another user holds a
      // live lock on this row; a no-op when the type has no edit locking.
      assertRowsWritable([current], type, actor.userId, now());

      const fields = await listFields(tx, current.contentTypeId);
      const validatedData = validateEntryData(fields, input.data);

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
            slug: current.slug,
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
        const fieldIdsByKey: Record<string, string> = {};
        for (const field of fields) {
          if (Object.hasOwn(validatedData, field.key)) {
            fieldIdsByKey[field.key] = field.id;
          }
        }
        const stagedSeo = input.seo !== undefined ? validatedSeo : current.seo;

        const [revisionRow] = await tx
          .insert(entryRevisions)
          .values({
            entryId: current.id,
            locale: current.locale,
            kind: 'save',
            data: validatedData,
            fieldIds: fieldIdsByKey,
            seo: stagedSeo,
            slug: resolvedSlug,
            authorId: actor.userId,
            createdAt: updatedAt,
          })
          .returning({ id: entryRevisions.id });
        if (revisionRow === undefined) {
          throw new Error(
            '@plakboek/content: entry revision insert returned no row',
          );
        }

        const previousPendingId = current.draftRevisionId;

        [row] = await tx
          .update(contentEntries)
          .set({
            draftRevisionId: revisionRow.id,
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

        // Replaces (never accumulates) the previous pending row once
        // revisions are disabled, or in on_publish mode -- plan 03-09 keeps
        // it as history in on_every_save mode.
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
      }

      const record = toEntryRecord(row);
      return {
        result: record,
        after: entrySnapshot(record),
      };
    },
  );
}
