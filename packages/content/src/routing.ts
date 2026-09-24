/**
 * Resolved-path computation, collision refusal and URL history writes
 * (TYPE-04, TYPE-06, D-29, D-31, D-33): a routable entry's live URL is
 * derived from its content type's URL pattern and materialised into
 * `content_entries.resolved_path` at publish time (plan `publish.ts`), never
 * saved eagerly. Collisions are refused two ways -- an explicit lookup for a
 * clear, named error, and the partial unique index
 * `content_entries_locale_resolved_path_unique` as the race backstop, mapped
 * to the same error shape.
 *
 * This module never updates or deletes a `content_entry_url_history` row:
 * `recordUrlHistory` only inserts (D-33 -- every change of a live path is
 * kept, so Phase 16 can redirect it).
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ContentConfig, ContentDeps } from './config.js';
import {
  contentEntries,
  contentEntryUrlHistory,
  contentTypes,
} from './schema.js';
import {
  parseUrlPattern,
  resolveUrlPath,
  type UrlPathInput,
} from './url-pattern.js';

/** Thrown by `computeEntryPath` when a routable content type has no URL
 * pattern configured yet (plan 03-08 owns setting it). */
export class UrlPatternRequiredError extends Error {
  readonly contentTypeId: string;

  constructor(contentTypeId: string) {
    super(
      `@plakboek/content: content type "${contentTypeId}" is routable but has no URL pattern configured`,
    );
    this.name = 'UrlPatternRequiredError';
    this.contentTypeId = contentTypeId;
  }
}

/** Thrown when `path` is already the resolved path of another entry in
 * `locale` (D-31): the second entry to resolve to a shared path is refused,
 * whichever content type it belongs to. `conflictingEntryId` names the
 * other entry when it is known from an explicit lookup (`assertPathAvailable`);
 * a race caught only via the unique-violation mapping
 * (`urlCollisionFromUniqueViolation`) cannot identify it and carries `null`. */
export class UrlCollisionError extends Error {
  readonly path: string;
  readonly locale: string;
  readonly conflictingEntryId: string | null;

  constructor(path: string, locale: string, conflictingEntryId: string | null) {
    super(
      `@plakboek/content: path "${path}" is already published in locale "${locale}"${
        conflictingEntryId === null ? '' : ` by entry "${conflictingEntryId}"`
      }`,
    );
    this.name = 'UrlCollisionError';
    this.path = path;
    this.locale = locale;
    this.conflictingEntryId = conflictingEntryId;
  }
}

export type ComputeEntryPathContentType = {
  readonly id: string;
  readonly routable: boolean;
  readonly urlPattern: string | null;
};

/**
 * Computes the resolved path for one entry (TYPE-04, TYPE-06): `null` for a
 * non-routable type (regardless of `entry`); `UrlPatternRequiredError` for a
 * routable type with no pattern configured; otherwise `resolveUrlPath`
 * against `entry` in `timezone` (may itself return `null` when a used token
 * -- `{slug}` or a date token -- has no value yet).
 */
export function computeEntryPath(
  type: ComputeEntryPathContentType,
  entry: UrlPathInput,
  timezone: string,
): string | null {
  if (!type.routable) return null;
  if (type.urlPattern === null) {
    throw new UrlPatternRequiredError(type.id);
  }
  return resolveUrlPath(type.urlPattern, entry, timezone);
}

export type AssertPathAvailableInput = {
  readonly path: string;
  readonly locale: string;
  readonly entryId: string;
};

/**
 * Throws `UrlCollisionError` when another row (any content type, excluding
 * `entryId` itself) already holds `resolved_path = path` in `locale` (D-31).
 * An explicit lookup, run before the write that would create the collision,
 * so the caller gets a clear error naming the other entry; the partial
 * unique index on `(locale, resolved_path)` is the concurrent-write backstop
 * -- see `urlCollisionFromUniqueViolation`.
 */
export async function assertPathAvailable(
  tx: AuditTransaction,
  input: AssertPathAvailableInput,
): Promise<void> {
  const [row] = await tx
    .select({ id: contentEntries.id })
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.locale, input.locale),
        eq(contentEntries.resolvedPath, input.path),
        ne(contentEntries.id, input.entryId),
      ),
    )
    .limit(1);
  if (row !== undefined) {
    throw new UrlCollisionError(input.path, input.locale, row.id);
  }
}

const UNIQUE_VIOLATION = '23505';
const RESOLVED_PATH_UNIQUE_CONSTRAINT =
  'content_entries_locale_resolved_path_unique';
const MAX_CAUSE_DEPTH = 3;

/** Walks the `cause` chain looking for a unique-violation on the resolved-path
 * constraint; returns `false` for any other failure. */
function isResolvedPathUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = Reflect.get(current, 'code');
    if (code === UNIQUE_VIOLATION) {
      const constraint = Reflect.get(current, 'constraint_name');
      return constraint === RESOLVED_PATH_UNIQUE_CONSTRAINT;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Maps a Postgres unique-violation on `content_entries_locale_resolved_path_unique`
 * to a `UrlCollisionError` (`conflictingEntryId: null` -- the violation alone
 * doesn't name the other entry), for callers that write `resolved_path`
 * directly and race another transaction past `assertPathAvailable`'s check.
 * Returns `undefined` for any other error.
 */
export function urlCollisionFromUniqueViolation(
  error: unknown,
  context: { readonly path: string; readonly locale: string },
): UrlCollisionError | undefined {
  if (!isResolvedPathUniqueViolation(error)) return undefined;
  return new UrlCollisionError(context.path, context.locale, null);
}

export type UrlHistoryReason =
  | 'slug_changed'
  | 'pattern_changed'
  | 'unpublished'
  | 'trashed'
  | 'deleted';

export type RecordUrlHistoryInput = {
  readonly entryId: string;
  readonly contentTypeId: string;
  readonly translationGroup: string;
  readonly locale: string;
  readonly oldPath: string;
  readonly reason: UrlHistoryReason;
  readonly changedAt: Date;
};

/**
 * Records that a published entry's resolved URL changed (D-33): inserts one
 * `content_entry_url_history` row naming the path it moved away from. This
 * module defines no update or delete helper for this table -- URL history is
 * append-only, kept for Phase 16's redirects even for changes made before
 * that phase shipped.
 */
export async function recordUrlHistory(
  tx: AuditTransaction,
  input: RecordUrlHistoryInput,
): Promise<void> {
  await tx.insert(contentEntryUrlHistory).values({
    entryId: input.entryId,
    contentTypeId: input.contentTypeId,
    translationGroup: input.translationGroup,
    locale: input.locale,
    oldPath: input.oldPath,
    reason: input.reason,
    changedAt: input.changedAt,
  });
}

/** Thrown when clearing a routable content type's URL pattern while any of
 * its entries is still published (D-32's mirror for the "clear" case): those
 * entries would lose their URLs with nothing left to resolve one. */
export class UrlPatternInUseError extends Error {
  readonly contentTypeId: string;
  readonly publishedCount: number;

  constructor(contentTypeId: string, publishedCount: number) {
    super(
      `@plakboek/content: content type "${contentTypeId}" cannot clear its URL pattern while ${publishedCount} entr${publishedCount === 1 ? 'y is' : 'ies are'} published`,
    );
    this.name = 'UrlPatternInUseError';
    this.contentTypeId = contentTypeId;
    this.publishedCount = publishedCount;
  }
}

/** One `(locale, path)` pair a URL pattern change would give to more than
 * one entry -- inside the type being changed, or against a published entry
 * of another type entirely (D-32). */
export type UrlPatternCollision = {
  readonly locale: string;
  readonly path: string;
  readonly entryIds: readonly string[];
};

/** Thrown by `setUrlPattern` when the new pattern would give two published
 * entries the same `(locale, path)` -- listing every colliding entry so the
 * caller can show them. Nothing is changed when this is thrown. */
export class UrlPatternCollisionError extends Error {
  readonly collisions: readonly UrlPatternCollision[];

  constructor(collisions: readonly UrlPatternCollision[]) {
    super(
      [
        '@plakboek/content: URL pattern change would collide:',
        ...collisions.map(
          (collision) =>
            `- "${collision.path}" (${collision.locale}): ${collision.entryIds.join(', ')}`,
        ),
      ].join('\n'),
    );
    this.name = 'UrlPatternCollisionError';
    this.collisions = collisions;
  }
}

export type ComputeUrlPatternChangeImpactInput = {
  readonly contentTypeKey: string;
  readonly urlPattern: string | null;
};

export type UrlPatternChangeImpact = {
  readonly publishedEntries: number;
  readonly changedPaths: number;
  readonly collisions: readonly UrlPatternCollision[];
};

/** Builds a stable map key for a `(locale, path)` pair via
 * `JSON.stringify` -- neither is validated against containing an
 * arbitrary delimiter character, so a plain string join isn't safe. */
function localePathKey(locale: string, path: string): string {
  return JSON.stringify([locale, path]);
}

/** The inverse of `localePathKey`, without an unsafe type assertion on
 * `JSON.parse`'s `any` result. */
function parseLocalePathKey(key: string): {
  readonly locale: string;
  readonly path: string;
} {
  const parsed: unknown = JSON.parse(key);
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === 'string' &&
    typeof parsed[1] === 'string'
  ) {
    return { locale: parsed[0], path: parsed[1] };
  }
  throw new TypeError(`@plakboek/content: malformed locale/path key "${key}"`);
}

/**
 * Reports what changing a routable content type's URL pattern to
 * `input.urlPattern` would do to its currently published entries (D-32):
 * how many entries are published, how many of their paths would actually
 * change, and every collision the change would cause -- inside the type
 * (two of its own entries landing on the same new path) and against another
 * type (a new path already held by a published entry elsewhere). No
 * uniqueness is enforced beyond this (D-31); this only reports what the
 * *change* would move.
 *
 * Read-only and takes a plain `db`, so it runs standalone for a caller
 * previewing a change, and again inside `setUrlPattern`'s own transaction
 * (passing its `tx`) so the write can never drift from what was previewed.
 */
export async function computeUrlPatternChangeImpact(
  db: AuditDatabase,
  config: ContentConfig,
  input: ComputeUrlPatternChangeImpactInput,
): Promise<UrlPatternChangeImpact> {
  const [type] = await db
    .select({ id: contentTypes.id })
    .from(contentTypes)
    .where(eq(contentTypes.key, input.contentTypeKey))
    .limit(1);
  if (type === undefined) {
    throw new Error(
      `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
    );
  }

  const parsed =
    input.urlPattern === null ? null : parseUrlPattern(input.urlPattern);

  const publishedRows = await db
    .select({
      id: contentEntries.id,
      locale: contentEntries.locale,
      slug: contentEntries.slug,
      publicId: contentEntries.publicId,
      firstPublishedAt: contentEntries.firstPublishedAt,
      resolvedPath: contentEntries.resolvedPath,
    })
    .from(contentEntries)
    .where(
      and(
        eq(contentEntries.contentTypeId, type.id),
        eq(contentEntries.status, 'published'),
      ),
    );

  type NewPath = { readonly locale: string; readonly path: string | null };
  const newPathsById = new Map<string, NewPath>();
  let changedPaths = 0;
  for (const row of publishedRows) {
    const path =
      parsed === null
        ? null
        : resolveUrlPath(
            parsed,
            {
              slug: row.slug,
              publicId: row.publicId,
              firstPublishedAt: row.firstPublishedAt,
            },
            config.timezone,
          );
    newPathsById.set(row.id, { locale: row.locale, path });
    if (path !== row.resolvedPath) changedPaths += 1;
  }

  // Collisions inside this type: two of its own entries landing on the same
  // new (locale, path).
  const groupedByLocalePath = new Map<string, string[]>();
  for (const [entryId, { locale, path }] of newPathsById) {
    if (path === null) continue;
    const key = localePathKey(locale, path);
    const existing = groupedByLocalePath.get(key);
    if (existing === undefined) groupedByLocalePath.set(key, [entryId]);
    else existing.push(entryId);
  }

  const collisionSets = new Map<string, Set<string>>();
  for (const [key, entryIds] of groupedByLocalePath) {
    if (entryIds.length > 1) {
      collisionSets.set(key, new Set(entryIds));
    }
  }

  // Collisions against another content type: a new path already held by a
  // published entry that isn't part of this type.
  for (const [entryId, { locale, path }] of newPathsById) {
    if (path === null) continue;
    const [conflict] = await db
      .select({ id: contentEntries.id })
      .from(contentEntries)
      .where(
        and(
          eq(contentEntries.locale, locale),
          eq(contentEntries.resolvedPath, path),
          ne(contentEntries.contentTypeId, type.id),
        ),
      )
      .limit(1);
    if (conflict !== undefined) {
      const key = localePathKey(locale, path);
      const existing = collisionSets.get(key) ?? new Set<string>();
      existing.add(entryId);
      existing.add(conflict.id);
      collisionSets.set(key, existing);
    }
  }

  const collisions: UrlPatternCollision[] = [];
  for (const [key, entryIds] of collisionSets) {
    const { locale, path } = parseLocalePathKey(key);
    collisions.push({ locale, path, entryIds: [...entryIds] });
  }

  return {
    publishedEntries: publishedRows.length,
    changedPaths,
    collisions,
  };
}

export type SetUrlPatternInput = {
  readonly contentTypeKey: string;
  readonly urlPattern: string | null;
};

export type SetUrlPatternResult = {
  readonly contentTypeId: string;
  readonly urlPattern: string | null;
  readonly changedPaths: number;
};

/**
 * Changes a routable content type's URL pattern (D-31, D-32, D-33), for a
 * role holding `content-types:edit`. Locks the type row (`FOR UPDATE`) for
 * the duration of the change. A non-routable type refuses with
 * `UrlPatternRequiredError`; clearing the pattern (`null`) while any entry
 * of the type is published refuses with `UrlPatternInUseError` instead --
 * those entries would lose their URLs. Otherwise recomputes the change's
 * impact inside this same transaction (`computeUrlPatternChangeImpact`, so
 * nothing can drift between the check and the write) and refuses with
 * `UrlPatternCollisionError` the moment it finds any collision, changing
 * nothing.
 *
 * On success, every affected published entry's `resolved_path` is cleared
 * in one statement first, then set to its new value in a second -- so two
 * entries swapping paths under the new pattern never trip the unique index
 * mid-update -- and each old path is recorded in URL history with reason
 * `pattern_changed` before it's overwritten. Runs through
 * `deps.recorder.run` (`content-types:edit` /
 * `content-type.set-url-pattern`).
 */
export async function setUrlPattern(
  deps: ContentDeps,
  actor: AuditActor,
  input: SetUrlPatternInput,
): Promise<SetUrlPatternResult> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'content-types:edit',
      action: 'content-type.set-url-pattern',
      entityType: 'content_type',
    },
    async (tx) => {
      const [type] = await tx
        .select({ id: contentTypes.id, routable: contentTypes.routable })
        .from(contentTypes)
        .where(eq(contentTypes.key, input.contentTypeKey))
        .for('update');
      if (type === undefined) {
        throw new Error(
          `@plakboek/content: no content type registered for key "${input.contentTypeKey}"`,
        );
      }
      if (!type.routable) {
        throw new UrlPatternRequiredError(type.id);
      }

      if (input.urlPattern === null) {
        const [publishedCountRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(contentEntries)
          .where(
            and(
              eq(contentEntries.contentTypeId, type.id),
              eq(contentEntries.status, 'published'),
            ),
          );
        const publishedCount = publishedCountRow?.count ?? 0;
        if (publishedCount > 0) {
          throw new UrlPatternInUseError(type.id, publishedCount);
        }
      }

      const impact = await computeUrlPatternChangeImpact(tx, deps.config, {
        contentTypeKey: input.contentTypeKey,
        urlPattern: input.urlPattern,
      });
      if (impact.collisions.length > 0) {
        throw new UrlPatternCollisionError(impact.collisions);
      }

      const parsed =
        input.urlPattern === null ? null : parseUrlPattern(input.urlPattern);

      const publishedRows = await tx
        .select({
          id: contentEntries.id,
          locale: contentEntries.locale,
          translationGroup: contentEntries.translationGroup,
          slug: contentEntries.slug,
          publicId: contentEntries.publicId,
          firstPublishedAt: contentEntries.firstPublishedAt,
          resolvedPath: contentEntries.resolvedPath,
        })
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.contentTypeId, type.id),
            eq(contentEntries.status, 'published'),
          ),
        );

      type ChangedPath = {
        readonly id: string;
        readonly locale: string;
        readonly translationGroup: string;
        readonly oldPath: string;
        readonly newPath: string | null;
      };
      const changed: ChangedPath[] = [];
      for (const row of publishedRows) {
        if (row.resolvedPath === null) continue;
        const newPath =
          parsed === null
            ? null
            : resolveUrlPath(
                parsed,
                {
                  slug: row.slug,
                  publicId: row.publicId,
                  firstPublishedAt: row.firstPublishedAt,
                },
                deps.config.timezone,
              );
        if (newPath !== row.resolvedPath) {
          changed.push({
            id: row.id,
            locale: row.locale,
            translationGroup: row.translationGroup,
            oldPath: row.resolvedPath,
            newPath,
          });
        }
      }

      const updatedAt = now();

      if (changed.length > 0) {
        // Two statements -- clear every changed row's path first, then set
        // the new ones -- so two entries swapping paths under the new
        // pattern never trip the unique index mid-update.
        await tx
          .update(contentEntries)
          .set({ resolvedPath: null })
          .where(
            inArray(
              contentEntries.id,
              changed.map((row) => row.id),
            ),
          );

        for (const row of changed) {
          await tx
            .update(contentEntries)
            .set({ resolvedPath: row.newPath })
            .where(eq(contentEntries.id, row.id));
          await recordUrlHistory(tx, {
            entryId: row.id,
            contentTypeId: type.id,
            translationGroup: row.translationGroup,
            locale: row.locale,
            oldPath: row.oldPath,
            reason: 'pattern_changed',
            changedAt: updatedAt,
          });
        }
      }

      await tx
        .update(contentTypes)
        .set({ urlPattern: input.urlPattern, updatedAt })
        .where(eq(contentTypes.id, type.id));

      const result: SetUrlPatternResult = {
        contentTypeId: type.id,
        urlPattern: input.urlPattern,
        changedPaths: changed.length,
      };
      return {
        result,
        after: { urlPattern: input.urlPattern, changedPaths: changed.length },
      };
    },
  );
}
