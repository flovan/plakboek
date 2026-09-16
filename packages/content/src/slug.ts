/**
 * Slug normalisation (TYPE-03): hand-rolled NFKD diacritic strip, no
 * dependency. Handles the diacritics 03-CONTEXT names (é, ë, ï) by Unicode
 * decomposition; Dutch "ij" needs no special case -- it is already two
 * plain ASCII letters.
 *
 * This module also owns entry slug generation and availability checking
 * (D-28, plan 03-04): `generateUniqueEntrySlug` and `assertEntrySlugAvailable`
 * are two distinct entry points, not one function branching on a flag, so a
 * hand-typed slug can never be silently renamed by code meant for generated
 * slugs (RESEARCH.md Pitfall 4).
 */
import type { AuditTransaction } from '@plakboek/auth';
import { and, eq, ne, sql } from 'drizzle-orm';
import { contentEntries } from './schema.js';

export const SLUG_MAX_LENGTH = 200;

const COMBINING_MARKS_PATTERN = /\p{M}+/gu;
const NON_SLUG_CHARACTER_RUN_PATTERN = /[^a-z0-9]+/g;
const LEADING_OR_TRAILING_HYPHENS_PATTERN = /^-+|-+$/g;

/**
 * NFKD-normalises, strips combining marks, lowercases, collapses every run
 * of non `[a-z0-9]` characters to a single hyphen, trims leading/trailing
 * hyphens, and truncates to `SLUG_MAX_LENGTH` (trimming a trailing hyphen
 * left by the cut). Returns `''` when nothing survives.
 */
export function normalizeSlug(input: string): string {
  const decomposed = input
    .normalize('NFKD')
    .replace(COMBINING_MARKS_PATTERN, '')
    .toLowerCase()
    .replace(NON_SLUG_CHARACTER_RUN_PATTERN, '-')
    .replace(LEADING_OR_TRAILING_HYPHENS_PATTERN, '');

  const truncated = decomposed.slice(0, SLUG_MAX_LENGTH);
  return truncated.replace(LEADING_OR_TRAILING_HYPHENS_PATTERN, '');
}

/** A normalised slug: one or more runs of `[a-z0-9]` joined by single
 * hyphens, at most `SLUG_MAX_LENGTH` characters. Rejects `'News'`,
 * `'news--2'`, `'-news'` and `''`. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `value` is already in normalised slug form (matches
 * `SLUG_PATTERN` and is at most `SLUG_MAX_LENGTH` characters). */
export function isNormalizedSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/** Thrown by `generateUniqueEntrySlug` when `base` normalises to an empty
 * string -- there is nothing to generate a slug from, so the caller must
 * ask for a hand-typed slug instead. */
export class SlugGenerationError extends Error {
  constructor(base: string) {
    super(
      `@plakboek/content: "${base}" normalises to an empty slug; a hand-typed slug is required`,
    );
    this.name = 'SlugGenerationError';
  }
}

/** Thrown by `assertEntrySlugAvailable` when the given slug is not already
 * in normalised form. `suggestion` is the normalised form (possibly empty)
 * so a caller can offer it back to the editor. */
export class InvalidSlugError extends Error {
  readonly suggestion: string;

  constructor(slug: string, suggestion: string) {
    super(
      `@plakboek/content: slug "${slug}" is not in normalized form (suggestion: "${suggestion}")`,
    );
    this.name = 'InvalidSlugError';
    this.suggestion = suggestion;
  }
}

/** Thrown when a hand-typed slug is already used by another entry of the
 * same content type and locale (D-28). Generated slugs never throw this --
 * `generateUniqueEntrySlug` suffixes instead. */
export class SlugConflictError extends Error {
  readonly slug: string;
  readonly locale: string;
  readonly contentTypeId: string;

  constructor(slug: string, locale: string, contentTypeId: string) {
    super(
      `@plakboek/content: slug "${slug}" is already used in locale "${locale}" for this content type`,
    );
    this.name = 'SlugConflictError';
    this.slug = slug;
    this.locale = locale;
    this.contentTypeId = contentTypeId;
  }
}

/**
 * First key of the two-integer transaction-scoped advisory lock namespace
 * reserved for entry slug generation (see `generateUniqueEntrySlug` below
 * for the call site). Two-integer advisory locks occupy a key space
 * distinct from the single-bigint keys `@plakboek/db`'s migration lock and
 * `@plakboek/auth`'s first-user lock (`FIRST_USER_LOCK_KEY`) use, so neither
 * space can collide with the other.
 */
export const CONTENT_SLUG_LOCK_NAMESPACE = 84_301;

const ENTRY_SLUG_UNIQUE_CONSTRAINT = 'content_entries_type_locale_slug_unique';
const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 3;

/** Appends `-${n}` to `base`, truncating `base` (and trimming a resulting
 * trailing hyphen) so the whole candidate never exceeds `SLUG_MAX_LENGTH`. */
function withSuffix(base: string, suffix: number): string {
  const suffixText = `-${suffix}`;
  const room = SLUG_MAX_LENGTH - suffixText.length;
  const truncatedBase = base
    .slice(0, room)
    .replace(LEADING_OR_TRAILING_HYPHENS_PATTERN, '');
  return `${truncatedBase}${suffixText}`;
}

async function isSlugTaken(
  tx: AuditTransaction,
  contentTypeId: string,
  locale: string,
  slug: string,
  excludeEntryId: string | undefined,
): Promise<boolean> {
  const conditions = [
    eq(contentEntries.contentTypeId, contentTypeId),
    eq(contentEntries.locale, locale),
    eq(contentEntries.slug, slug),
  ];
  if (excludeEntryId !== undefined) {
    conditions.push(ne(contentEntries.id, excludeEntryId));
  }
  const rows = await tx
    .select({ id: contentEntries.id })
    .from(contentEntries)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

export type GenerateUniqueEntrySlugInput = {
  readonly contentTypeId: string;
  readonly locale: string;
  readonly base: string;
  readonly excludeEntryId?: string;
};

/**
 * Generates a slug from `input.base`, unique within `(contentTypeId,
 * locale)` (D-28). Normalises `base` first (`SlugGenerationError` when
 * nothing survives), then takes a transaction-scoped advisory lock scoped to
 * `(contentTypeId, locale)` before searching, so two concurrent callers
 * generating from the same base never race into the same slug: the second
 * blocks until the first commits its insert and releases the lock. The base
 * is returned as-is when free; otherwise the lowest free `-2`, `-3`, ...
 * suffix, truncating the base so the result never exceeds `SLUG_MAX_LENGTH`.
 */
export async function generateUniqueEntrySlug(
  tx: AuditTransaction,
  input: GenerateUniqueEntrySlugInput,
): Promise<string> {
  const normalizedBase = normalizeSlug(input.base);
  if (normalizedBase.length === 0) {
    throw new SlugGenerationError(input.base);
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${CONTENT_SLUG_LOCK_NAMESPACE}, hashtext(${input.contentTypeId} || ':' || ${input.locale}))`,
  );

  const baseTaken = await isSlugTaken(
    tx,
    input.contentTypeId,
    input.locale,
    normalizedBase,
    input.excludeEntryId,
  );
  if (!baseTaken) {
    return normalizedBase;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = withSuffix(normalizedBase, suffix);
    // Sequential by design: each candidate depends on the previous one's
    // absence, and the advisory lock above already serializes this search.
    const candidateTaken = await isSlugTaken(
      tx,
      input.contentTypeId,
      input.locale,
      candidate,
      input.excludeEntryId,
    );
    if (!candidateTaken) {
      return candidate;
    }
  }
}

export type AssertEntrySlugAvailableInput = {
  readonly contentTypeId: string;
  readonly locale: string;
  readonly slug: string;
  readonly excludeEntryId?: string;
};

/**
 * Checks that a hand-typed `input.slug` is available in `(contentTypeId,
 * locale)`, never modifying it (D-28, T-03-19). A slug not already in
 * normalised form throws `InvalidSlugError` with the normalised suggestion.
 * A slug already held by another entry (other than `excludeEntryId`) throws
 * `SlugConflictError`.
 */
export async function assertEntrySlugAvailable(
  tx: AuditTransaction,
  input: AssertEntrySlugAvailableInput,
): Promise<void> {
  if (!isNormalizedSlug(input.slug)) {
    throw new InvalidSlugError(input.slug, normalizeSlug(input.slug));
  }

  const taken = await isSlugTaken(
    tx,
    input.contentTypeId,
    input.locale,
    input.slug,
    input.excludeEntryId,
  );
  if (taken) {
    throw new SlugConflictError(input.slug, input.locale, input.contentTypeId);
  }
}

/** Walks the `cause` chain looking for a unique-violation on the entry slug
 * constraint; returns `undefined` for any other failure. */
function isEntrySlugUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = Reflect.get(current, 'code');
    if (code === UNIQUE_VIOLATION) {
      const constraint = Reflect.get(current, 'constraint_name');
      return constraint === ENTRY_SLUG_UNIQUE_CONSTRAINT;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Maps a Postgres unique-violation on `content_entries_type_locale_slug_unique`
 * to a `SlugConflictError`, for callers that write the slug directly (e.g. a
 * publish path racing another transaction past `assertEntrySlugAvailable`'s
 * check). Returns `undefined` for any other error.
 */
export function slugConflictFromUniqueViolation(
  error: unknown,
  context: {
    readonly slug: string;
    readonly locale: string;
    readonly contentTypeId: string;
  },
): SlugConflictError | undefined {
  if (!isEntrySlugUniqueViolation(error)) return undefined;
  return new SlugConflictError(
    context.slug,
    context.locale,
    context.contentTypeId,
  );
}
