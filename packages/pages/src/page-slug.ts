/**
 * Page slug generation, availability checking and unique-violation mapping
 * (D-23), modelled directly on `@plakboek/content`'s `slug.ts`. Uniqueness
 * is on the full, locale-scoped `path` (`pages_locale_path_unique`), not the
 * bare slug -- a root page and a child page may share a slug because their
 * paths differ, and the same slug may exist in two locales under the same
 * parent.
 *
 * `PAGE_SLUG_LOCK_NAMESPACE = 84_302` is a distinct transaction-scoped
 * advisory lock namespace from `@plakboek/content`'s
 * `CONTENT_SLUG_LOCK_NAMESPACE = 84_301`, so page slug generation never
 * serialises against entry slug generation.
 *
 * All slug errors -- including the tracer's `InvalidPageSlugError` -- live
 * in this module, so `pages.ts` re-exports it from here rather than
 * defining its own copy.
 */
import type { AuditTransaction } from '@plakboek/auth';
import {
  isNormalizedSlug,
  normalizeSlug,
  SLUG_MAX_LENGTH,
} from '@plakboek/content';
import { and, eq, ne, sql } from 'drizzle-orm';
import { pages } from './schema.js';

/**
 * First key of the two-integer transaction-scoped advisory lock namespace
 * reserved for page slug generation -- distinct from
 * `@plakboek/content`'s `CONTENT_SLUG_LOCK_NAMESPACE = 84_301`, so page and
 * entry slug generation never serialize against each other.
 */
export const PAGE_SLUG_LOCK_NAMESPACE = 84_302;

const LEADING_OR_TRAILING_HYPHENS_PATTERN = /^-+|-+$/g;
const MAX_SLUG_GENERATION_ATTEMPTS = 500;
const PAGE_PATH_UNIQUE_CONSTRAINT = 'pages_locale_path_unique';
const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 3;

/** Thrown when a title or an explicit slug normalises to an empty string,
 * or an explicit slug is not already in normalised form -- there is
 * nothing to derive a slug from, or the caller must supply one already
 * normalised (never silently renamed, mirrors `@plakboek/content`'s D-28
 * discipline for pages, D-23). */
export class InvalidPageSlugError extends Error {
  readonly input: string;

  constructor(input: string) {
    super(`@plakboek/pages: "${input}" normalises to an empty slug`);
    this.name = 'InvalidPageSlugError';
    this.input = input;
  }
}

/** Thrown when a hand-typed slug's composed path is already used by
 * another page in the same locale (D-23). `existingPageId` is `null` only
 * when the conflict is discovered through the unique-violation backstop
 * (`pageSlugConflictFromUniqueViolation`), which cannot name the other
 * row. */
export class PageSlugConflictError extends Error {
  readonly locale: string;
  readonly path: string;
  readonly existingPageId: string | null;

  constructor(locale: string, path: string, existingPageId: string | null) {
    super(
      `@plakboek/pages: path "${path}" is already used in locale "${locale}"${
        existingPageId === null ? '' : ` by page "${existingPageId}"`
      }`,
    );
    this.name = 'PageSlugConflictError';
    this.locale = locale;
    this.path = path;
    this.existingPageId = existingPageId;
  }
}

/** Thrown by `generateUniquePageSlug` when every candidate up to
 * `MAX_SLUG_GENERATION_ATTEMPTS` is already taken -- practically
 * unreachable, a belt-and-braces bound so a stuck search fails loudly
 * instead of looping forever. */
export class PageSlugGenerationError extends Error {
  readonly base: string;

  constructor(base: string) {
    super(
      `@plakboek/pages: could not generate a unique slug from "${base}" after ${MAX_SLUG_GENERATION_ATTEMPTS} attempts`,
    );
    this.name = 'PageSlugGenerationError';
    this.base = base;
  }
}

/** Returns `slug` at the root (`parentPath === null`) and
 * `` `${parentPath}/${slug}` `` otherwise -- the single definition of what
 * a page path is, used by create, rename and move so the three can never
 * disagree about it. No leading or trailing slash, matching
 * `pages_path_check`. */
export function composePagePath(
  parentPath: string | null,
  slug: string,
): string {
  return parentPath === null ? slug : `${parentPath}/${slug}`;
}

/**
 * Derives the second `pg_advisory_xact_lock` key from a stable FNV-1a hash
 * of `locale` and `parentPageId` (the literal `@root` at the top level), so
 * concurrent creations under different parents or locales never block each
 * other. Pure and deterministic: the same pair always yields the same key.
 */
export function pageSlugLockKey(
  locale: string,
  parentPageId: string | null,
): number {
  const key = `${locale}:${parentPageId ?? '@root'}`;
  let hash = 0x811c_9dc5; // FNV-1a 32-bit offset basis
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash | 0; // fits Postgres' int4 (signed 32-bit) advisory-lock key
}

/** Appends `-${suffix}` to `base`, truncating `base` (and trimming a
 * resulting trailing hyphen) so the candidate never exceeds
 * `SLUG_MAX_LENGTH` -- mirrors `@plakboek/content`'s `slug.ts` exactly. */
function withSuffix(base: string, suffix: number): string {
  const suffixText = `-${suffix}`;
  const room = SLUG_MAX_LENGTH - suffixText.length;
  const truncatedBase = base
    .slice(0, room)
    .replace(LEADING_OR_TRAILING_HYPHENS_PATTERN, '');
  return `${truncatedBase}${suffixText}`;
}

/** Returns the id of the page already holding `(locale, path)`, excluding
 * `excludePageId` when given, or `undefined` when the path is free. One
 * exact-match query per call -- never a prefetched regex batch (Phase 3's
 * truncated-base lesson, STATE.md Phase 3-04 decision: a prefetch pattern
 * built from an untruncated base misses a previously truncated
 * candidate). */
async function findPagePathHolder(
  tx: AuditTransaction,
  locale: string,
  path: string,
  excludePageId: string | undefined,
): Promise<string | undefined> {
  const conditions = [eq(pages.locale, locale), eq(pages.path, path)];
  if (excludePageId !== undefined) {
    conditions.push(ne(pages.id, excludePageId));
  }
  const [row] = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(...conditions))
    .limit(1);
  return row?.id;
}

export type AssertPageSlugAvailableInput = {
  readonly locale: string;
  readonly slug: string;
  readonly parentPath: string | null;
  readonly parentPageId: string | null;
  readonly excludePageId?: string;
};

/**
 * Checks a hand-typed `input.slug`, never modifying it (D-23): not already
 * normalised throws `InvalidPageSlugError`; its composed path already held
 * by another page in `input.locale` throws `PageSlugConflictError` naming
 * that page. Takes the transaction-scoped advisory lock first (own
 * namespace, key scoped to `(locale, parentPageId)`), so a concurrent
 * `generateUniquePageSlug`/`assertPageSlugAvailable` call under the same
 * parent and locale serialises against this one rather than racing it.
 */
export async function assertPageSlugAvailable(
  tx: AuditTransaction,
  input: AssertPageSlugAvailableInput,
): Promise<void> {
  if (!isNormalizedSlug(input.slug)) {
    throw new InvalidPageSlugError(input.slug);
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${PAGE_SLUG_LOCK_NAMESPACE}, ${pageSlugLockKey(input.locale, input.parentPageId)})`,
  );

  const path = composePagePath(input.parentPath, input.slug);
  const holderId = await findPagePathHolder(
    tx,
    input.locale,
    path,
    input.excludePageId,
  );
  if (holderId !== undefined) {
    throw new PageSlugConflictError(input.locale, path, holderId);
  }
}

export type GenerateUniquePageSlugInput = {
  readonly locale: string;
  readonly parentPath: string | null;
  readonly parentPageId: string | null;
  readonly base: string;
  readonly excludePageId?: string;
};

/**
 * Generates a slug from `input.base`, unique within `(locale,
 * parentPageId)` on the composed full path (D-23). Normalises `base` first
 * (`InvalidPageSlugError` when nothing survives), then takes the same
 * transaction-scoped advisory lock `assertPageSlugAvailable` does before
 * searching, so two concurrent callers generating from the same base under
 * the same parent and locale never race into the same slug: the second
 * blocks until the first commits its insert and releases the lock. The
 * base is returned as-is when free; otherwise the lowest free `-2`, `-3`,
 * ... suffix -- each candidate checked with its own exact-match query
 * against the composed full path, never a prefetched regex batch, so a
 * previously truncated candidate is never missed.
 */
export async function generateUniquePageSlug(
  tx: AuditTransaction,
  input: GenerateUniquePageSlugInput,
): Promise<string> {
  const normalizedBase = normalizeSlug(input.base);
  if (normalizedBase.length === 0) {
    throw new InvalidPageSlugError(input.base);
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${PAGE_SLUG_LOCK_NAMESPACE}, ${pageSlugLockKey(input.locale, input.parentPageId)})`,
  );

  const basePath = composePagePath(input.parentPath, normalizedBase);
  const baseHolder = await findPagePathHolder(
    tx,
    input.locale,
    basePath,
    input.excludePageId,
  );
  if (baseHolder === undefined) {
    return normalizedBase;
  }

  for (let suffix = 2; suffix <= MAX_SLUG_GENERATION_ATTEMPTS; suffix += 1) {
    const candidate = withSuffix(normalizedBase, suffix);
    const candidatePath = composePagePath(input.parentPath, candidate);
    // Sequential by design: each candidate depends on the previous one's
    // absence, and the advisory lock above already serializes this search.
    const holder = await findPagePathHolder(
      tx,
      input.locale,
      candidatePath,
      input.excludePageId,
    );
    if (holder === undefined) {
      return candidate;
    }
  }
  throw new PageSlugGenerationError(normalizedBase);
}

/** Walks the `cause` chain looking for a unique-violation on
 * `pages_locale_path_unique`; returns `false` for any other failure. */
function isPagePathUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code: unknown = Reflect.get(current, 'code');
    if (code === UNIQUE_VIOLATION) {
      const constraint: unknown = Reflect.get(current, 'constraint_name');
      return constraint === PAGE_PATH_UNIQUE_CONSTRAINT;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Maps a Postgres unique-violation on `pages_locale_path_unique` to a
 * `PageSlugConflictError` (`existingPageId: null` -- the violation alone
 * doesn't name the other page), for a caller that writes `path` directly
 * and races another transaction past `assertPageSlugAvailable`'s check.
 * Returns `null` for any other error.
 */
export function pageSlugConflictFromUniqueViolation(
  error: unknown,
  context: { readonly locale: string; readonly path: string },
): PageSlugConflictError | null {
  if (!isPagePathUniqueViolation(error)) return null;
  return new PageSlugConflictError(context.locale, context.path, null);
}
