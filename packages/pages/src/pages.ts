/**
 * Page creation, rename and the row-loading primitives `tree.ts`/`publish.ts`
 * build on (D-20, D-21, D-23). Mirrors `@plakboek/content`'s `entries.ts`
 * shape. Slug derivation, availability and generation live in
 * `page-slug.ts` -- this module composes them with the recorder's
 * transaction, load-and-lock reads, and the insert/update itself.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import {
  assertPageSlugAvailable,
  composePagePath,
  generateUniquePageSlug,
} from './page-slug.js';
import { pages } from './schema.js';
import { PAGE_STATUSES, type PageRecord, type PageStatus } from './types.js';

// All slug errors -- including the format/availability/generation checks
// `createPage` and `renamePage` rely on -- are defined in `page-slug.ts`
// (D-23). Re-exported here so index.ts's existing `from './pages.js'`
// import keeps resolving unchanged.
export { InvalidPageSlugError } from './page-slug.js';

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

/** Thrown when the computed `path` is already used by another page in the
 * same locale (`pages_locale_path_unique`) -- the race backstop behind
 * `createPage`'s slug resolution, and the whole-subtree collision refusal
 * `movePage`/`renamePage` run before writing anything. */
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

/** Thrown when a structural write's `basePageVersion` no longer matches
 * the owning page's current `version` (D-38: insert, move, rename and
 * delete all take the page version, because those genuinely conflict).
 * Defined here (not `tree.ts`, which used to own it) so `pages.ts` itself
 * -- `movePage`, `renamePage` -- can throw it without importing back from
 * `tree.ts`, which already imports `loadPageForUpdate` from here; `tree.ts`
 * re-exports it unchanged so nothing downstream (`publish.ts`, the package
 * barrel) needed to move. */
export class StalePageVersionError extends Error {
  readonly pageId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(pageId: string, expectedVersion: number, actualVersion: number) {
    super(
      `@plakboek/pages: page "${pageId}" was modified by someone else since it was loaded (expected version ${expectedVersion}, now ${actualVersion})`,
    );
    this.name = 'StalePageVersionError';
    this.pageId = pageId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
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
 * recorder opens. Through `deps.recorder.run` (`pages:create` /
 * `page.create`): loads the parent's `path` (`FOR SHARE`) when given; a
 * manual `input.slug` goes through `assertPageSlugAvailable`
 * (`slugSource: 'manual'`, refuses on a clash), an omitted one through
 * `generateUniquePageSlug` from `input.title` (`slugSource: 'generated'`,
 * resolves a clash with `-2`, `-3`, ...); composes `path` via
 * `composePagePath`; inserts with a fresh `translation_group`, `status
 * 'draft'`, `version 1`, `created_by`/`updated_by` the actor and both
 * timestamps from `deps.now`. A unique violation on
 * `pages_locale_path_unique` becomes `PagePathConflictError` -- the race
 * backstop behind the advisory-lock-serialised slug resolution above.
 */
export async function createPage(
  deps: PagesDeps,
  actor: AuditActor,
  input: CreatePageInput,
): Promise<PageRecord> {
  if (!deps.config.content.locales.includes(input.locale)) {
    throw new LocaleNotEnabledError(input.locale);
  }
  const now = deps.now ?? (() => new Date());
  const parentPageId = input.parentPageId ?? null;

  return await deps.recorder.run(
    actor,
    { permission: 'pages:create', action: 'page.create', entityType: 'page' },
    async (tx) => {
      let parentPath: string | null = null;
      if (parentPageId !== null) {
        const [parent] = await tx
          .select({ path: pages.path })
          .from(pages)
          .where(eq(pages.id, parentPageId))
          .for('share');
        if (parent === undefined) {
          throw new PageNotFoundError(parentPageId);
        }
        parentPath = parent.path;
      }

      let slug: string;
      let slugSource: 'generated' | 'manual';
      if (input.slug !== undefined) {
        slugSource = 'manual';
        await assertPageSlugAvailable(tx, {
          locale: input.locale,
          slug: input.slug,
          parentPath,
          parentPageId,
        });
        slug = input.slug;
      } else {
        slugSource = 'generated';
        slug = await generateUniquePageSlug(tx, {
          locale: input.locale,
          parentPath,
          parentPageId,
          base: input.title,
        });
      }
      const path = composePagePath(parentPath, slug);
      const createdAt = now();

      try {
        const [row] = await tx
          .insert(pages)
          .values({
            translationGroup: randomUUID(),
            locale: input.locale,
            parentPageId,
            slug,
            slugSource,
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

export type RenamePageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
  readonly title?: string;
  readonly slug?: string;
};

/**
 * Renames a page's title and/or slug (D-21, D-23). Through
 * `deps.recorder.run` (`pages:edit` / `page.rename`): loads and locks the
 * page `FOR UPDATE`, throwing `StalePageVersionError` on a version
 * mismatch. A supplied `slug` different from the current one goes through
 * the same manual-refuses split `createPage` uses
 * (`assertPageSlugAvailable`, excluding the page's own id); an omitted or
 * unchanged `slug` leaves `slugSource` untouched. Establishes the slug
 * split this plan's Task 2 completes with descendant path propagation and
 * URL history.
 */
export async function renamePage(
  deps: PagesDeps,
  actor: AuditActor,
  input: RenamePageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'page.rename',
      entityType: 'page',
      entityId: input.pageId,
    },
    async (tx) => {
      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.baseVersion) {
        throw new StalePageVersionError(
          page.id,
          input.baseVersion,
          page.version,
        );
      }

      let parentPath: string | null = null;
      if (page.parentPageId !== null) {
        const [parent] = await tx
          .select({ path: pages.path })
          .from(pages)
          .where(eq(pages.id, page.parentPageId))
          .for('share');
        parentPath = parent?.path ?? null;
      }

      let newSlug = page.slug;
      let slugSource = page.slugSource;
      if (input.slug !== undefined && input.slug !== page.slug) {
        slugSource = 'manual';
        await assertPageSlugAvailable(tx, {
          locale: page.locale,
          slug: input.slug,
          parentPath,
          parentPageId: page.parentPageId,
          excludePageId: page.id,
        });
        newSlug = input.slug;
      }
      const path = composePagePath(parentPath, newSlug);

      const updatedAt = now();
      const [row] = await tx
        .update(pages)
        .set({
          slug: newSlug,
          slugSource,
          path,
          title: input.title ?? page.title,
          version: sql`${pages.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(eq(pages.id, page.id))
        .returning();
      if (row === undefined) {
        throw new Error('@plakboek/pages: page rename update returned no row');
      }
      const record = toPageRecord(row);
      return { result: record, after: record };
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
