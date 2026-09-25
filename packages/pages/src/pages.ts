/**
 * Page creation and the row-loading primitives `tree.ts`/`publish.ts` build
 * on (D-20, D-21, D-23). Mirrors `@plakboek/content`'s `entries.ts` shape.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { normalizeSlug } from '@plakboek/content';
import { eq } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { pages } from './schema.js';
import { PAGE_STATUSES, type PageRecord, type PageStatus } from './types.js';

function isPageStatus(value: string): value is PageStatus {
  return PAGE_STATUSES.some((status) => status === value);
}

function asPageStatus(value: string): PageStatus {
  if (isPageStatus(value)) return value;
  throw new TypeError(
    `@plakboek/pages: unexpected status "${value}" stored for a page`,
  );
}

function asSlugSource(value: string): 'generated' | 'manual' {
  if (value === 'generated' || value === 'manual') return value;
  throw new TypeError(
    `@plakboek/pages: unexpected slug_source "${value}" stored for a page`,
  );
}

function toPageRecord(row: typeof pages.$inferSelect): PageRecord {
  return {
    id: row.id,
    translationGroup: row.translationGroup,
    locale: row.locale,
    parentPageId: row.parentPageId,
    slug: row.slug,
    slugSource: asSlugSource(row.slugSource),
    path: row.path,
    resolvedPath: row.resolvedPath,
    title: row.title,
    status: asPageStatus(row.status),
    seo: row.seo,
    version: row.version,
    livePublicationId: row.livePublicationId,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    firstPublishedAt: row.firstPublishedAt,
    scheduledAt: row.scheduledAt,
    trashedAt: row.trashedAt,
  };
}

/** Thrown when `locale` is not one of `deps.config.content.locales`. */
export class LocaleNotEnabledError extends Error {
  readonly locale: string;

  constructor(locale: string) {
    super(
      `@plakboek/pages: locale "${locale}" is not enabled in ContentConfig`,
    );
    this.name = 'LocaleNotEnabledError';
    this.locale = locale;
  }
}

/** Thrown by `createPage` when `input.slug ?? input.title` normalises to
 * an empty string -- there is nothing to derive a slug from. */
export class InvalidPageSlugError extends Error {
  readonly input: string;

  constructor(input: string) {
    super(`@plakboek/pages: "${input}" normalises to an empty slug`);
    this.name = 'InvalidPageSlugError';
    this.input = input;
  }
}

/** Thrown when the computed `path` is already used by another page in the
 * same locale (`pages_locale_path_unique`). */
export class PagePathConflictError extends Error {
  readonly path: string;
  readonly locale: string;

  constructor(path: string, locale: string) {
    super(
      `@plakboek/pages: path "${path}" is already used in locale "${locale}"`,
    );
    this.name = 'PagePathConflictError';
    this.path = path;
    this.locale = locale;
  }
}

/** Thrown by `loadPageForUpdate` when no row matches `pageId`. */
export class PageNotFoundError extends Error {
  readonly pageId: string;

  constructor(pageId: string) {
    super(`@plakboek/pages: no page found for id "${pageId}"`);
    this.name = 'PageNotFoundError';
    this.pageId = pageId;
  }
}

const PAGE_PATH_UNIQUE_CONSTRAINT = 'pages_locale_path_unique';
const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 3;

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

export type CreatePageInput = {
  readonly locale: string;
  readonly title: string;
  readonly slug?: string;
  readonly parentPageId?: string | null;
};

/**
 * Creates a draft page (D-20, D-21, D-23). Rejects a locale not enabled in
 * `deps.config.content.locales` with `LocaleNotEnabledError` before the
 * recorder opens; derives the slug as `normalizeSlug(input.slug ??
 * input.title)`, throwing `InvalidPageSlugError` when the result is empty.
 * Through `deps.recorder.run` (`pages:create` / `page.create`): computes
 * `path` as the parent's `path + '/' + slug` (parent loaded `FOR SHARE`) or
 * `slug` at the root, inserts with a fresh `translation_group`, `status
 * 'draft'`, `version 1`, `created_by`/`updated_by` the actor and both
 * timestamps from `deps.now`. A unique violation on
 * `pages_locale_path_unique` becomes `PagePathConflictError`.
 */
export async function createPage(
  deps: PagesDeps,
  actor: AuditActor,
  input: CreatePageInput,
): Promise<PageRecord> {
  if (!deps.config.content.locales.includes(input.locale)) {
    throw new LocaleNotEnabledError(input.locale);
  }
  const slugSource = input.slug ?? input.title;
  const slug = normalizeSlug(slugSource);
  if (slug.length === 0) {
    throw new InvalidPageSlugError(slugSource);
  }
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    { permission: 'pages:create', action: 'page.create', entityType: 'page' },
    async (tx) => {
      let parentPath: string | null = null;
      if (input.parentPageId !== null && input.parentPageId !== undefined) {
        const [parent] = await tx
          .select({ path: pages.path })
          .from(pages)
          .where(eq(pages.id, input.parentPageId))
          .for('share');
        if (parent === undefined) {
          throw new PageNotFoundError(input.parentPageId);
        }
        parentPath = parent.path;
      }
      const path = parentPath === null ? slug : `${parentPath}/${slug}`;
      const createdAt = now();

      try {
        const [row] = await tx
          .insert(pages)
          .values({
            translationGroup: randomUUID(),
            locale: input.locale,
            parentPageId: input.parentPageId ?? null,
            slug,
            slugSource: 'generated',
            path,
            title: input.title,
            status: 'draft',
            version: 1,
            createdBy: actor.userId,
            updatedBy: actor.userId,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        if (row === undefined) {
          throw new Error('@plakboek/pages: page insert returned no row');
        }
        const record = toPageRecord(row);
        return { result: record, after: record };
      } catch (error) {
        if (isPagePathUniqueViolation(error)) {
          throw new PagePathConflictError(path, input.locale);
        }
        throw error;
      }
    },
  );
}

/** Reads one page by id, or `null` when none exists. Not permission-gated:
 * reads are internal API, gated by later phases' HTTP/admin layers. */
export async function getPage(
  db: AuditDatabase,
  pageId: string,
): Promise<PageRecord | null> {
  const [row] = await db
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  return row === undefined ? null : toPageRecord(row);
}

/** Loads and locks one page row (`SELECT ... FOR UPDATE`) inside an
 * audited mutation's transaction, for a structural write's page-version
 * check (D-38) -- kept package-internal (not part of the barrel): a caller
 * reaching it directly could lock a page row outside any audited
 * mutation. Throws `PageNotFoundError` when no row matches `pageId`. */
export async function loadPageForUpdate(
  tx: AuditTransaction,
  pageId: string,
): Promise<PageRecord> {
  const [row] = await tx
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .for('update');
  if (row === undefined) {
    throw new PageNotFoundError(pageId);
  }
  return toPageRecord(row);
}
