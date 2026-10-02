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
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { assertPageWritable } from './locks.js';
import {
  assertPageSlugAvailable,
  composePagePath,
  generateUniquePageSlug,
} from './page-slug.js';
import { registerPagePurge } from './purge.js';
import { pages, pageUrlHistory } from './schema.js';
import { getPageEditLocking } from './settings.js';
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

/** Maps a raw `pages` row to the camelCase `PageRecord` shape. Exported
 * (not part of the barrel) so `translations.ts` and `locale.ts` can reuse
 * the same mapping instead of duplicating it. */
export function toPageRecord(row: typeof pages.$inferSelect): PageRecord {
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

/** Thrown by `movePage` when the destination parent's `locale` differs from
 * the moved page's -- the hierarchy never crosses a locale (D-34, D-36). */
export class LocaleMismatchError extends Error {
  readonly pageLocale: string;
  readonly parentLocale: string;

  constructor(pageLocale: string, parentLocale: string) {
    super(
      `@plakboek/pages: cannot move a page (locale "${pageLocale}") under a parent in a different locale ("${parentLocale}")`,
    );
    this.name = 'LocaleMismatchError';
    this.pageLocale = pageLocale;
    this.parentLocale = parentLocale;
  }
}

/** Thrown by `movePage` when the destination parent is the moved page
 * itself or one of its own descendants -- refused before anything is
 * written. A materialised path has no meaning for a page moved under its
 * own subtree. */
export class CircularPageMoveError extends Error {
  readonly pageId: string;
  readonly destinationParentId: string;

  constructor(pageId: string, destinationParentId: string) {
    super(
      `@plakboek/pages: cannot move page "${pageId}" under its own descendant "${destinationParentId}"`,
    );
    this.name = 'CircularPageMoveError';
    this.pageId = pageId;
    this.destinationParentId = destinationParentId;
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

/** `%` and `_` are LIKE metacharacters; a page path containing either
 * (literally allowed by `pages_path_check`) must not be able to widen a
 * descendant-prefix match (T-04-42). Postgres' default LIKE escape
 * character is a backslash, so escaping with one here is enough -- no
 * separate `ESCAPE` clause is needed. */
const LIKE_METACHARACTER_PATTERN = /[%_]/g;
function escapeLikePattern(value: string): string {
  return value.replace(LIKE_METACHARACTER_PATTERN, (char) => `\\${char}`);
}

/** Reads an affected-row count from a raw `execute()` result across
 * drivers: postgres-js reports `count`, node-postgres reports `rowCount`.
 * Mirrors `@plakboek/content`'s `revisions.ts` helper of the same shape.
 * Throwing rather than defaulting to `0` is deliberate: the caller uses
 * this count to assert the whole subtree was rewritten in one statement,
 * and silently reporting `0` would hide a genuine mismatch. */
function affectedRowCount(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    for (const property of ['count', 'rowCount']) {
      const value: unknown = Reflect.get(result, property);
      if (typeof value === 'number') return value;
    }
  }
  throw new TypeError(
    '@plakboek/pages: could not read the affected row count from the database driver',
  );
}

export type PageUrlHistoryReason =
  | 'slug_changed'
  | 'moved'
  | 'pattern_changed'
  | 'unpublished'
  | 'trashed'
  | 'deleted';

export type RecordPageUrlHistoryInput = {
  readonly pageId: string;
  readonly translationGroup: string;
  readonly locale: string;
  readonly oldPath: string;
  readonly reason: PageUrlHistoryReason;
  readonly changedAt: Date;
};

/**
 * Records that a page's resolved URL changed (D-21, mirrors
 * `@plakboek/content`'s `recordUrlHistory`): inserts one append-only
 * `page_url_history` row naming the path it moved away from. This module
 * defines no update or delete for that table -- URL history is append-only,
 * kept for Phase 16's redirects. Exported for `page-routing.ts`'s
 * `setPageUrlPattern` (04-11) to call from its own already-open audited
 * transaction, but deliberately absent from the package barrel
 * (`index.ts`): a caller reaching it directly could write history outside
 * any audited mutation.
 */
export async function recordPageUrlHistory(
  tx: AuditTransaction,
  input: RecordPageUrlHistoryInput,
): Promise<void> {
  await tx.insert(pageUrlHistory).values({
    pageId: input.pageId,
    translationGroup: input.translationGroup,
    locale: input.locale,
    oldPath: input.oldPath,
    reason: input.reason,
    changedAt: input.changedAt,
  });
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

/** A row's destination inside a move/rename's subtree rewrite: its own old
 * path, its computed new path, and the identifying fields
 * `recordPageUrlHistory` needs. Shared shape between `movePage` and
 * `renamePage` -- both rewrite a subtree the same way, only the new prefix
 * and history reason differ. */
type SubtreeDestination = {
  readonly id: string;
  readonly translationGroup: string;
  readonly locale: string;
  readonly oldPath: string;
  readonly newPath: string;
};

/** Selects the given page and every descendant `FOR UPDATE` in one query,
 * using the materialised path (`pages_locale_path_prefix_idx`): `path =
 * rootPath` for the row itself, `path LIKE 'rootPath/%'` for descendants.
 * `%`/`_` in `rootPath` are escaped first (T-04-42) and the whole LIKE
 * argument is bound as one parameter through Drizzle's tagged `sql`
 * template -- never concatenated. */
async function loadSubtreeForUpdate(
  tx: AuditTransaction,
  locale: string,
  rootPath: string,
): Promise<readonly PageRecord[]> {
  const likeArgument = `${escapeLikePattern(rootPath)}/%`;
  const rows = await tx
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.locale, locale),
        sql`(${pages.path} = ${rootPath} OR ${pages.path} LIKE ${likeArgument})`,
      ),
    )
    .orderBy(pages.path)
    .for('update');
  return rows.map(toPageRecord);
}

/** Computes every subtree row's destination path: `oldPrefix` replaced by
 * `newPrefix`, keeping each row's suffix past the moved/renamed page's own
 * path unchanged. */
function computeSubtreeDestinations(
  subtree: readonly PageRecord[],
  oldPrefix: string,
  newPrefix: string,
): readonly SubtreeDestination[] {
  return subtree.map((row) => ({
    id: row.id,
    translationGroup: row.translationGroup,
    locale: row.locale,
    oldPath: row.path,
    newPath:
      row.path === oldPrefix
        ? newPrefix
        : `${newPrefix}${row.path.slice(oldPrefix.length)}`,
  }));
}

/** Refuses when any destination path in `destinations` is already held by
 * a page outside the moving/renaming set itself -- the whole subtree's
 * destinations are checked in one query, before any write, so a
 * descendant collision (not just the root's own) is caught (T-04-43). */
async function assertSubtreeDestinationsAvailable(
  tx: AuditTransaction,
  locale: string,
  destinations: readonly SubtreeDestination[],
): Promise<void> {
  const movingIds = new Set(destinations.map((destination) => destination.id));
  const collisionRows = await tx
    .select({ id: pages.id, path: pages.path })
    .from(pages)
    .where(
      and(
        eq(pages.locale, locale),
        inArray(
          pages.path,
          destinations.map((destination) => destination.newPath),
        ),
      ),
    );
  const collision = collisionRows.find((row) => !movingIds.has(row.id));
  if (collision !== undefined) {
    throw new PagePathConflictError(collision.path, locale);
  }
}

/** Appends one `page_url_history` row per changed destination, before the
 * path rewrite -- so each row captures the path it moved away from, not
 * the new one (a discrimination check in `page-hierarchy.test.ts` proves
 * this ordering is load-bearing). A destination whose path didn't actually
 * change (e.g. a title-only rename) is skipped: nothing moved for it. */
async function recordSubtreeUrlHistory(
  tx: AuditTransaction,
  destinations: readonly SubtreeDestination[],
  reason: PageUrlHistoryReason,
  changedAt: Date,
): Promise<void> {
  for (const destination of destinations) {
    if (destination.newPath === destination.oldPath) continue;
    await recordPageUrlHistory(tx, {
      pageId: destination.id,
      translationGroup: destination.translationGroup,
      locale: destination.locale,
      oldPath: destination.oldPath,
      reason,
      changedAt,
    });
  }
}

/**
 * Rewrites every destination's `path` (and, for the row matching
 * `rootPageId`, `parent_page_id` to `newParentPageId`) in ONE batched
 * `UPDATE ... FROM (VALUES ...)` statement -- never one statement per row.
 * Each row's `version` is bumped and its `resolved_path` cleared, but only
 * when that row's path actually changed: a published page's materialised
 * address is derived from its path (plan 04-11 recomputes it), and leaving
 * a stale value would violate `pages_locale_resolved_path_unique` the
 * moment another page takes that freed address; a row whose path didn't
 * move keeps its `resolved_path` untouched. Throws when the affected-row
 * count doesn't equal `destinations.length` -- the whole subtree must move
 * together, never partially.
 */
async function applySubtreeRewrite(
  tx: AuditTransaction,
  destinations: readonly SubtreeDestination[],
  rootPageId: string,
  newParentPageId: string | null,
  updatedBy: string,
  updatedAt: Date,
): Promise<void> {
  const valuesClause = sql.join(
    destinations.map(
      (destination) =>
        sql`(${destination.id}::uuid, ${destination.newPath}::text)`,
    ),
    sql`, `,
  );
  // `updatedAt` is bound as its ISO string form with an explicit
  // `::timestamptz` cast, never as a bare `Date` -- a raw tagged-template
  // query binding a `Date` object directly trips a parameter-binding bug
  // in this environment's postgres.js/pg driver stack (reproduced
  // standalone with a single-parameter `UPDATE ... SET updated_at =
  // ${date}` and no other clause at all: `reset.str` in the driver's byte
  // encoder receives a `Date` instance where it expects a string).
  // Drizzle's own query builder (`.values({ updatedAt })` elsewhere in
  // this file) is unaffected -- it already serializes `Date` through the
  // column's driver-value mapper before handing off to the driver; only a
  // *raw* `sql\`...\`` template hits this.
  const result = await tx.execute(sql`
    UPDATE pages SET
      path = v.new_path,
      parent_page_id = CASE
        WHEN pages.id = ${rootPageId}::uuid THEN ${newParentPageId}::uuid
        ELSE pages.parent_page_id
      END,
      resolved_path = CASE
        WHEN v.new_path <> pages.path THEN NULL
        ELSE pages.resolved_path
      END,
      version = pages.version + 1,
      updated_at = ${updatedAt.toISOString()}::timestamptz,
      updated_by = ${updatedBy}
    FROM (VALUES ${valuesClause}) AS v(id, new_path)
    WHERE pages.id = v.id
  `);
  const affected = affectedRowCount(result);
  if (affected !== destinations.length) {
    throw new Error(
      `@plakboek/pages: subtree rewrite affected ${affected} row(s), expected ${destinations.length}`,
    );
  }
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
 * unchanged `slug` leaves `slugSource` untouched.
 *
 * A slug change rewrites the page and every descendant's `path` the same
 * way `movePage` does -- one batched statement, collision-checked across
 * the whole subtree first, each changed row's old path recorded in
 * `page_url_history` with reason `slug_changed`, its `resolved_path`
 * cleared when its path moved. The page's own `parent_page_id` never
 * changes here.
 */
export async function renamePage(
  deps: PagesDeps,
  actor: AuditActor,
  input: RenamePageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getPage(deps.db, input.pageId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'page.rename',
      entityType: 'page',
      entityId: input.pageId,
      ...(before === null
        ? {}
        : {
            before: {
              slug: before.slug,
              path: before.path,
              title: before.title,
            },
          }),
    },
    async (tx, context) => {
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
      const newPrefix = composePagePath(parentPath, newSlug);

      const subtree = await loadSubtreeForUpdate(tx, page.locale, page.path);
      // The whole subtree, not just the renamed page's own row: a slug
      // change rewrites path/version on every descendant too
      // (applySubtreeRewrite, below), which is exactly the collision a
      // colleague's live lock on any one of them exists to prevent. `subtree`
      // already contains the renamed page's own row (loadSubtreeForUpdate's
      // `path = rootPath` branch), so one call covers both -- mirrors
      // lifecycle.ts's trashPage/deletePagePermanently precedent.
      assertPageWritable(
        subtree,
        await getPageEditLocking(tx),
        actor.userId,
        now(),
      );
      const destinations = computeSubtreeDestinations(
        subtree,
        page.path,
        newPrefix,
      );

      if (newPrefix !== page.path) {
        await assertSubtreeDestinationsAvailable(tx, page.locale, destinations);
      }

      const updatedAt = now();
      await recordSubtreeUrlHistory(
        tx,
        destinations,
        'slug_changed',
        updatedAt,
      );
      await applySubtreeRewrite(
        tx,
        destinations,
        page.id,
        page.parentPageId,
        actor.userId,
        updatedAt,
      );

      // The batched rewrite above only touches `path`/`resolved_path`/
      // `version` -- title and slug are this page's own fields, set here.
      const [renamedRow] = await tx
        .update(pages)
        .set({ slug: newSlug, slugSource, title: input.title ?? page.title })
        .where(eq(pages.id, page.id))
        .returning();
      if (renamedRow === undefined) {
        throw new Error(
          '@plakboek/pages: renamed page vanished mid-transaction',
        );
      }
      // A slug change addresses the whole subtree differently, so every
      // page in it is purged. A title-only rename purges the page alone: the
      // served <title> falls back to the page title.
      registerPagePurge(
        deps,
        context,
        newPrefix === page.path ? [page.id] : subtree.map((row) => row.id),
      );

      const record = toPageRecord(renamedRow);
      return {
        result: record,
        after: { slug: record.slug, path: record.path, title: record.title },
      };
    },
  );
}

export type MovePageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
  readonly newParentPageId: string | null;
};

/**
 * Moves a page (and its whole subtree -- a materialised path has no
 * meaning for an orphaned child) to a new parent, or to the root when
 * `newParentPageId` is `null` (D-21). Through `deps.recorder.run`
 * (`pages:edit` / `page.move`): loads and locks the page `FOR UPDATE`,
 * throwing `StalePageVersionError` on a version mismatch; loads and locks
 * the destination parent `FOR UPDATE` when non-null, refusing
 * `LocaleMismatchError` when its locale differs (D-34, D-36); selects the
 * moved page and every descendant `FOR UPDATE` in one query; refuses
 * `CircularPageMoveError` when the destination is the moved page itself or
 * one of its descendants; computes every row's destination path and
 * refuses `PagePathConflictError` on any whole-subtree collision, before
 * writing anything; appends one `page_url_history` row per changed page
 * (reason `moved`) capturing its own old path; rewrites the whole subtree
 * in one batched statement, bumping every row's `version` and clearing a
 * changed row's stale `resolved_path`.
 */
export async function movePage(
  deps: PagesDeps,
  actor: AuditActor,
  input: MovePageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getPage(deps.db, input.pageId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: 'page.move',
      entityType: 'page',
      entityId: input.pageId,
      ...(before === null
        ? {}
        : { before: { parentPageId: before.parentPageId, path: before.path } }),
    },
    async (tx, context) => {
      const page = await loadPageForUpdate(tx, input.pageId);
      if (page.version !== input.baseVersion) {
        throw new StalePageVersionError(
          page.id,
          input.baseVersion,
          page.version,
        );
      }
      let destinationParentPath: string | null = null;
      if (input.newParentPageId !== null) {
        const [destinationParent] = await tx
          .select({ locale: pages.locale, path: pages.path })
          .from(pages)
          .where(eq(pages.id, input.newParentPageId))
          .for('update');
        if (destinationParent === undefined) {
          throw new PageNotFoundError(input.newParentPageId);
        }
        if (destinationParent.locale !== page.locale) {
          throw new LocaleMismatchError(page.locale, destinationParent.locale);
        }
        destinationParentPath = destinationParent.path;
      }

      const subtree = await loadSubtreeForUpdate(tx, page.locale, page.path);
      // The whole subtree, not just the moved page's own row: moving
      // rewrites path/parent_page_id/version on every descendant too
      // (applySubtreeRewrite, below), which is exactly the collision a
      // colleague's live lock on any one of them exists to prevent.
      // `subtree` already contains the moved page's own row
      // (loadSubtreeForUpdate's `path = rootPath` branch), so one call
      // covers both -- mirrors lifecycle.ts's
      // trashPage/deletePagePermanently precedent.
      assertPageWritable(
        subtree,
        await getPageEditLocking(tx),
        actor.userId,
        now(),
      );

      if (input.newParentPageId !== null) {
        const isSelfOrDescendant = subtree.some(
          (row) => row.id === input.newParentPageId,
        );
        if (isSelfOrDescendant) {
          throw new CircularPageMoveError(page.id, input.newParentPageId);
        }
      }

      const newPrefix = composePagePath(destinationParentPath, page.slug);
      const destinations = computeSubtreeDestinations(
        subtree,
        page.path,
        newPrefix,
      );
      await assertSubtreeDestinationsAvailable(tx, page.locale, destinations);

      const changedAt = now();
      await recordSubtreeUrlHistory(tx, destinations, 'moved', changedAt);
      await applySubtreeRewrite(
        tx,
        destinations,
        page.id,
        input.newParentPageId,
        actor.userId,
        changedAt,
      );

      const [movedRow] = await tx
        .select()
        .from(pages)
        .where(eq(pages.id, page.id))
        .limit(1);
      if (movedRow === undefined) {
        throw new Error('@plakboek/pages: moved page vanished mid-transaction');
      }
      // Every page whose address changed loses its cached HTML; a move to
      // the current parent changes no address and purges the page alone.
      const addressChanged = destinations.some(
        (destination) => destination.newPath !== destination.oldPath,
      );
      registerPagePurge(
        deps,
        context,
        addressChanged
          ? destinations.map((destination) => destination.id)
          : [page.id],
      );

      const record = toPageRecord(movedRow);
      return {
        result: record,
        after: { parentPageId: record.parentPageId, path: record.path },
      };
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

export type GetPageByPathInput = {
  readonly locale: string;
  readonly path: string;
};

/** Reads one page by its locale-scoped `path` -- one indexed equality read
 * (`pages_locale_path_unique`), or `null` when none exists. Not
 * permission-gated (see `getPage`). */
export async function getPageByPath(
  db: AuditDatabase,
  input: GetPageByPathInput,
): Promise<PageRecord | null> {
  const [row] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.locale, input.locale), eq(pages.path, input.path)))
    .limit(1);
  return row === undefined ? null : toPageRecord(row);
}

export type ListChildPagesInput = {
  readonly parentPageId: string | null;
  readonly locale: string;
};

/** Reads a page's direct children (`parentPageId: null` for root pages),
 * ordered by `slug` then `id`. Not permission-gated (see `getPage`). */
export async function listChildPages(
  db: AuditDatabase,
  input: ListChildPagesInput,
): Promise<readonly PageRecord[]> {
  const condition =
    input.parentPageId === null
      ? and(isNull(pages.parentPageId), eq(pages.locale, input.locale))
      : and(
          eq(pages.parentPageId, input.parentPageId),
          eq(pages.locale, input.locale),
        );
  const rows = await db
    .select()
    .from(pages)
    .where(condition)
    .orderBy(asc(pages.slug), asc(pages.id));
  return rows.map(toPageRecord);
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
