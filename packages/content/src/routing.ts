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
import type { AuditTransaction } from '@plakboek/auth';
import { and, eq, ne } from 'drizzle-orm';
import { contentEntries, contentEntryUrlHistory } from './schema.js';
import { resolveUrlPath, type UrlPathInput } from './url-pattern.js';

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
