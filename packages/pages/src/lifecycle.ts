/**
 * Page status transitions and the permanent-delete impact-then-apply pair
 * (D-20, D-21, D-22, D-38): the live-side status model pages reuse
 * verbatim from Phase 3's entries (`@plakboek/content`'s `lifecycle.ts`,
 * the module this one mirrors operation for operation). Every transition
 * loads and locks the page row (`FOR UPDATE`), checks its `baseVersion`
 * FIRST -- before any status check runs, matching `save.ts`/`publish.ts`'s
 * own D-42-before-D-43/45 ordering carried over from Phase 3 -- then
 * applies one `UPDATE` that bumps `version` and `updated_at`/`updated_by`.
 *
 * Unpublishing and trashing both give up a live address, so both record it
 * in `page_url_history` (D-21) before clearing `resolved_path`. None of
 * these operations ever set `status` to `'published'` -- that transition
 * belongs to `publishPage` alone (`publish.ts`).
 *
 * Trashing cascades over a page's whole subtree (a descendant reachable
 * only through a trashed ancestor would be published at an address whose
 * ancestor no longer resolves) and restoring reverses exactly the pages
 * that same trash operation marked -- tracked by giving every row in one
 * trash a shared `trashed_at` instant and matching restore against it,
 * never by re-deriving the subtree at restore time (CONTEXT.md "Leftovers
 * not discussed").
 *
 * `deletePagePermanently` is the one operation that actually removes rows,
 * gated by the distinct `pages:delete-permanent` permission. Because
 * `block_revisions.owner_id` carries no foreign key (D-24, schema.ts), its
 * rows are removed by an explicit delete keyed on `owner_type`/`owner_id`
 * -- no database cascade reaches them. The delete order matches
 * `locale.ts`'s `purgeLocale` exactly, so the two deleters in this package
 * can never disagree.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import {
  getPage,
  loadPageForUpdate,
  PageNotFoundError,
  recordPageUrlHistory,
  toPageRecord,
  StalePageVersionError,
} from './pages.js';
import {
  blockRevisions,
  pageBlocks,
  pagePublications,
  pages,
  pageUrlHistory,
} from './schema.js';
import type { PageRecord, PageStatus } from './types.js';

/** Thrown when a page's current status doesn't allow the requested
 * lifecycle operation -- `requiredStatuses` names every status the
 * operation would have accepted. */
export class PageStatusError extends Error {
  readonly pageId: string;
  readonly currentStatus: PageStatus;
  readonly requiredStatuses: readonly PageStatus[];

  constructor(
    pageId: string,
    currentStatus: PageStatus,
    requiredStatuses: readonly PageStatus[],
  ) {
    super(
      `@plakboek/pages: page "${pageId}" has status "${currentStatus}" -- this operation requires one of: ${requiredStatuses.join(', ')}`,
    );
    this.name = 'PageStatusError';
    this.pageId = pageId;
    this.currentStatus = currentStatus;
    this.requiredStatuses = Object.freeze([...requiredStatuses]);
  }
}

/** Thrown by `schedulePage` when `scheduledAt` is not strictly after the
 * clock's current instant -- scheduling for "now" or a past instant would
 * never fire. */
export class PageScheduleNotInFutureError extends Error {
  readonly scheduledAt: Date;
  readonly now: Date;

  constructor(scheduledAt: Date, now: Date) {
    super(
      `@plakboek/pages: cannot schedule for "${scheduledAt.toISOString()}" -- it is not after the current instant "${now.toISOString()}"`,
    );
    this.name = 'PageScheduleNotInFutureError';
    this.scheduledAt = scheduledAt;
    this.now = now;
  }
}

/** The `before`/`after` shape every status-only transition audits. */
function lifecycleSnapshot(page: PageRecord) {
  return {
    version: page.version,
    status: page.status,
    resolvedPath: page.resolvedPath,
    scheduledAt: page.scheduledAt,
    trashedAt: page.trashedAt,
  };
}

/** `%` and `_` are LIKE metacharacters; a page path containing either
 * (literally allowed by `pages_path_check`) must not be able to widen a
 * descendant-prefix match (T-04-42). Mirrors `pages.ts`'s helper of the
 * same shape. */
const LIKE_METACHARACTER_PATTERN = /[%_]/g;
function escapeLikePattern(value: string): string {
  return value.replace(LIKE_METACHARACTER_PATTERN, (char) => `\\${char}`);
}

/** The `(locale, path-prefix)` condition shared by every subtree read in
 * this module -- the root row itself (`path = rootPath`) plus every
 * descendant (`path LIKE 'rootPath/%'`), mirrors `pages.ts`'s
 * `loadSubtreeForUpdate`. */
function subtreeCondition(locale: string, rootPath: string) {
  const likeArgument = `${escapeLikePattern(rootPath)}/%`;
  return and(
    eq(pages.locale, locale),
    sql`(${pages.path} = ${rootPath} OR ${pages.path} LIKE ${likeArgument})`,
  );
}

/** Reads one page row, throwing `PageNotFoundError` when it doesn't
 * exist. */
async function loadPageRow(
  db: AuditDatabase,
  pageId: string,
): Promise<PageRecord> {
  const [row] = await db
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  if (row === undefined) {
    throw new PageNotFoundError(pageId);
  }
  return toPageRecord(row);
}

/** Reads `rootPageId` and every descendant, unlocked -- the read-only shape
 * `computePageTrashImpact`/`computePagePermanentDeleteImpact` need. */
async function selectSubtree(
  db: AuditDatabase,
  input: { readonly pageId: string },
): Promise<readonly PageRecord[]> {
  const root = await loadPageRow(db, input.pageId);
  const rows = await db
    .select()
    .from(pages)
    .where(subtreeCondition(root.locale, root.path))
    .orderBy(pages.path);
  return rows.map(toPageRecord);
}

/** Reads and locks (`FOR UPDATE`) `rootPageId` and every descendant, inside
 * an already-open audited transaction -- the write shape `trashPage`/
 * `restorePageFromTrash`/`deletePagePermanently` need before rewriting the
 * whole set together. */
async function selectSubtreeForUpdate(
  tx: AuditTransaction,
  locale: string,
  rootPath: string,
): Promise<readonly PageRecord[]> {
  const rows = await tx
    .select()
    .from(pages)
    .where(subtreeCondition(locale, rootPath))
    .orderBy(pages.path)
    .for('update');
  return rows.map(toPageRecord);
}

/** Every ancestor PATH of `path`, root-most first -- `path` itself is never
 * included. For `"a/b/c"` returns `["a", "a/b"]`. */
function ancestorPathsOf(path: string): readonly string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'));
  }
  return ancestors;
}

/** Thrown by `restorePageFromTrash` when an ancestor of the page being
 * restored is still `trashed` -- a descendant reachable only through a
 * trashed ancestor would be published at an address whose ancestor no
 * longer resolves. Names the closest such ancestor when more than one
 * qualifies. */
export class AncestorTrashedError extends Error {
  readonly pageId: string;
  readonly ancestorPageId: string;

  constructor(pageId: string, ancestorPageId: string) {
    super(
      `@plakboek/pages: cannot restore page "${pageId}" -- its ancestor "${ancestorPageId}" is still trashed`,
    );
    this.name = 'AncestorTrashedError';
    this.pageId = pageId;
    this.ancestorPageId = ancestorPageId;
  }
}

export type UnpublishPageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
};

/**
 * Unpublishes a published page (D-20), for a role holding `pages:publish`.
 * Only allowed from `published` (`PageStatusError` otherwise): `status`
 * becomes `draft`, `resolved_path` is cleared and, when it was set,
 * recorded in `page_url_history` first with reason `unpublished`;
 * `live_publication_id` and `published_at` are cleared too. The page's
 * first-published marker, its title/slug/path and every block/revision/
 * publication row are left untouched, so a later `publishPage` call
 * resolves the same address again and the publication row keeps serving
 * `listPageRevisionBatches`/history reads even though nothing serves it to
 * a visitor. Runs through `deps.recorder.run` (`pages:publish` /
 * `page.unpublish`).
 */
export async function unpublishPage(
  deps: PagesDeps,
  actor: AuditActor,
  input: UnpublishPageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getPage(deps.db, input.pageId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:publish',
      action: 'page.unpublish',
      entityType: 'page',
      entityId: input.pageId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadPageForUpdate(tx, input.pageId);
      if (current.version !== input.baseVersion) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status !== 'published') {
        throw new PageStatusError(current.id, current.status, ['published']);
      }

      const updatedAt = now();
      if (current.resolvedPath !== null) {
        await recordPageUrlHistory(tx, {
          pageId: current.id,
          translationGroup: current.translationGroup,
          locale: current.locale,
          oldPath: current.resolvedPath,
          reason: 'unpublished',
          changedAt: updatedAt,
        });
      }

      const [row] = await tx
        .update(pages)
        .set({
          status: 'draft',
          resolvedPath: null,
          publishedAt: null,
          livePublicationId: null,
          version: sql`${pages.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(
          and(eq(pages.id, input.pageId), eq(pages.version, input.baseVersion)),
        )
        .returning();
      if (row === undefined) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      const record = toPageRecord(row);
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

export type SchedulePageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
  readonly scheduledAt: Date;
};

/**
 * Schedules a draft page for a future instant (D-20), for a role holding
 * `pages:publish`. Only allowed from `draft` (`PageStatusError`
 * otherwise -- a published page has already gone live, and a scheduled
 * transition describes the live side becoming live): `status` becomes
 * `scheduled` and `scheduled_at` is set to `input.scheduledAt`.
 * `input.scheduledAt` at or before the clock's current instant throws
 * `PageScheduleNotInFutureError` instead of writing anything. This never
 * publishes anything itself -- the job that publishes a page once
 * `scheduled_at` arrives is a later phase's concern, mirroring
 * `@plakboek/content`'s identical PUB-04 boundary. Runs through
 * `deps.recorder.run` (`pages:publish` / `page.schedule`).
 */
export async function schedulePage(
  deps: PagesDeps,
  actor: AuditActor,
  input: SchedulePageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getPage(deps.db, input.pageId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:publish',
      action: 'page.schedule',
      entityType: 'page',
      entityId: input.pageId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadPageForUpdate(tx, input.pageId);
      if (current.version !== input.baseVersion) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status !== 'draft') {
        throw new PageStatusError(current.id, current.status, ['draft']);
      }

      const updatedAt = now();
      if (input.scheduledAt.getTime() <= updatedAt.getTime()) {
        throw new PageScheduleNotInFutureError(input.scheduledAt, updatedAt);
      }

      const [row] = await tx
        .update(pages)
        .set({
          status: 'scheduled',
          scheduledAt: input.scheduledAt,
          version: sql`${pages.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(
          and(eq(pages.id, input.pageId), eq(pages.version, input.baseVersion)),
        )
        .returning();
      if (row === undefined) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      const record = toPageRecord(row);
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

export type UnschedulePageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
};

/**
 * Cancels a pending schedule (D-20), for a role holding `pages:publish`.
 * Only allowed from `scheduled` (`PageStatusError` otherwise): `status`
 * returns to `draft` and `scheduled_at` is cleared, without publishing
 * anything. Runs through `deps.recorder.run` (`pages:publish` /
 * `page.unschedule`).
 */
export async function unschedulePage(
  deps: PagesDeps,
  actor: AuditActor,
  input: UnschedulePageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getPage(deps.db, input.pageId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:publish',
      action: 'page.unschedule',
      entityType: 'page',
      entityId: input.pageId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadPageForUpdate(tx, input.pageId);
      if (current.version !== input.baseVersion) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status !== 'scheduled') {
        throw new PageStatusError(current.id, current.status, ['scheduled']);
      }

      const updatedAt = now();
      const [row] = await tx
        .update(pages)
        .set({
          status: 'draft',
          scheduledAt: null,
          version: sql`${pages.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(
          and(eq(pages.id, input.pageId), eq(pages.version, input.baseVersion)),
        )
        .returning();
      if (row === undefined) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      const record = toPageRecord(row);
      return { result: record, after: lifecycleSnapshot(record) };
    },
  );
}

// -- Trash, restore and the permanent delete with its impact report --------

export type PageTrashImpact = {
  readonly pageId: string;
  readonly pageCount: number;
  readonly publishedCount: number;
  readonly blockCount: number;
};

/**
 * Reports what trashing `input.pageId` would touch: the page and every
 * descendant it would cascade to (`pageCount`), how many of those rows
 * currently carry a live address (`publishedCount` -- counted by
 * `resolved_path` non-null, the exact set `trashPage` itself appends a
 * `page_url_history` row for), and how many `page_blocks` rows the whole
 * subtree holds (`blockCount`). Read-only, one query per counted relation,
 * using the same escaped `LIKE`-prefix descendant read `movePage` uses.
 */
export async function computePageTrashImpact(
  db: AuditDatabase,
  input: { readonly pageId: string },
): Promise<PageTrashImpact> {
  const subtree = await selectSubtree(db, input);
  const publishedCount = subtree.filter(
    (page) => page.resolvedPath !== null,
  ).length;

  const ids = subtree.map((page) => page.id);
  const [blockCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageBlocks)
    .where(
      and(eq(pageBlocks.ownerType, 'page'), inArray(pageBlocks.ownerId, ids)),
    );

  return {
    pageId: input.pageId,
    pageCount: subtree.length,
    publishedCount,
    blockCount: blockCountRow?.count ?? 0,
  };
}

export type TrashPageInput = {
  readonly pageId: string;
  readonly baseVersion: number;
};

/**
 * Trashes a page and its whole subtree (D-21, CONTEXT.md "Leftovers not
 * discussed"), for a role holding `pages:delete`. Allowed from any status
 * but `trashed` (`PageStatusError` otherwise): selects the page and its
 * descendants `FOR UPDATE` by path prefix, then -- excluding any row
 * already `trashed` by an EARLIER, separate operation, which is left
 * entirely untouched -- appends one `trashed` `page_url_history` row per
 * row whose `resolved_path` is non-null (carrying that address), then
 * applies ONE batched `UPDATE` over that filtered set -- `status` to
 * `'trashed'`, `resolved_path` and `live_publication_id` cleared, `version`
 * bumped -- all sharing the SAME `trashed_at` instant (taken once from
 * `deps.now()`). That shared instant, and the exclusion of already-trashed
 * rows, is what `restorePageFromTrash` matches on: a descendant trashed
 * earlier keeps its OWN, different `trashed_at` and is never swept back up
 * by this page's own later restore. Runs through `deps.recorder.run`
 * (`pages:delete` / `page.trash`).
 */
export async function trashPage(
  deps: PagesDeps,
  actor: AuditActor,
  input: TrashPageInput,
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const impactCounts = await computePageTrashImpact(deps.db, {
    pageId: input.pageId,
  });

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:delete',
      action: 'page.trash',
      entityType: 'page',
      entityId: input.pageId,
      before: impactCounts,
    },
    async (tx) => {
      const current = await loadPageForUpdate(tx, input.pageId);
      if (current.version !== input.baseVersion) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status === 'trashed') {
        throw new PageStatusError(current.id, current.status, [
          'draft',
          'published',
          'scheduled',
        ]);
      }

      const subtree = await selectSubtreeForUpdate(
        tx,
        current.locale,
        current.path,
      );
      const trashedAt = now();

      // A descendant already `trashed` by its OWN, earlier operation is
      // left entirely alone here -- not re-stamped with THIS operation's
      // shared `trashed_at`. Only rows newly becoming trashed by this call
      // share the new instant, which is exactly what makes a
      // separately-trashed descendant survive an ancestor's later restore
      // (CONTEXT.md "Leftovers not discussed"): if this cascade overwrote
      // its earlier instant, restoring the ancestor would match on it too.
      const toTrash = subtree.filter((row) => row.status !== 'trashed');

      for (const row of toTrash) {
        if (row.resolvedPath !== null) {
          await recordPageUrlHistory(tx, {
            pageId: row.id,
            translationGroup: row.translationGroup,
            locale: row.locale,
            oldPath: row.resolvedPath,
            reason: 'trashed',
            changedAt: trashedAt,
          });
        }
      }

      const ids = toTrash.map((row) => row.id);
      await tx
        .update(pages)
        .set({
          status: 'trashed',
          trashedAt,
          resolvedPath: null,
          livePublicationId: null,
          version: sql`${pages.version} + 1`,
          updatedAt: trashedAt,
          updatedBy: actor.userId,
        })
        .where(inArray(pages.id, ids));

      const record = await loadPageRow(tx, input.pageId);
      return {
        result: record,
        after: { ...lifecycleSnapshot(record), pageCount: subtree.length },
      };
    },
  );
}

/**
 * Restores a trashed page (and every descendant trashed by that SAME
 * operation) to `draft` (D-21, CONTEXT.md "Leftovers not discussed"), for
 * a role holding `pages:delete`. Only allowed from `trashed`
 * (`PageStatusError` otherwise). Walks the page's ancestors by path prefix
 * and refuses `AncestorTrashedError` -- naming the closest one -- when any
 * is still `trashed`, writing nothing. Otherwise selects the page and
 * every descendant whose `trashed_at` equals THIS page's own `trashed_at`
 * (the shared-instant match, never a re-derived subtree) and applies ONE
 * batched `UPDATE` over that set: `status` to `'draft'`, `trashed_at`
 * cleared. Never sets `resolved_path` and never republishes -- restoring
 * is not the same act as publishing again. Runs through
 * `deps.recorder.run` (`pages:delete` / `page.restore`).
 */
export async function restorePageFromTrash(
  deps: PagesDeps,
  actor: AuditActor,
  input: {
    readonly pageId: string;
    readonly baseVersion: number;
  },
): Promise<PageRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getPage(deps.db, input.pageId);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:delete',
      action: 'page.restore',
      entityType: 'page',
      entityId: input.pageId,
      ...(before === null ? {} : { before: lifecycleSnapshot(before) }),
    },
    async (tx) => {
      const current = await loadPageForUpdate(tx, input.pageId);
      if (current.version !== input.baseVersion) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }
      if (current.status !== 'trashed') {
        throw new PageStatusError(current.id, current.status, ['trashed']);
      }
      if (current.trashedAt === null) {
        throw new Error(
          `@plakboek/pages: page "${current.id}" is trashed but carries no trashed_at`,
        );
      }
      const trashedAt = current.trashedAt;

      const ancestorPaths = ancestorPathsOf(current.path);
      if (ancestorPaths.length > 0) {
        const ancestorRows = await tx
          .select({ id: pages.id, path: pages.path, status: pages.status })
          .from(pages)
          .where(
            and(
              eq(pages.locale, current.locale),
              inArray(pages.path, ancestorPaths),
            ),
          );
        const trashedAncestor = ancestorRows
          .filter((row) => row.status === 'trashed')
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (trashedAncestor !== undefined) {
          throw new AncestorTrashedError(current.id, trashedAncestor.id);
        }
      }

      const rows = await tx
        .select()
        .from(pages)
        .where(
          and(
            subtreeCondition(current.locale, current.path),
            eq(pages.trashedAt, trashedAt),
          ),
        )
        .for('update');
      const ids = rows.map((row) => row.id);

      const updatedAt = now();
      await tx
        .update(pages)
        .set({
          status: 'draft',
          trashedAt: null,
          version: sql`${pages.version} + 1`,
          updatedAt,
          updatedBy: actor.userId,
        })
        .where(inArray(pages.id, ids));

      const record = await loadPageRow(tx, input.pageId);
      return {
        result: record,
        after: { ...lifecycleSnapshot(record), pageCount: ids.length },
      };
    },
  );
}

export type PagePermanentDeleteImpact = {
  readonly pageId: string;
  readonly pageCount: number;
  readonly blockCount: number;
  readonly blockRevisionCount: number;
  readonly publicationCount: number;
  readonly urlHistoryCount: number;
};

/**
 * Reports what permanently deleting `input.pageId` would remove: the page
 * and its whole subtree (`pageCount`), the `page_blocks`,
 * `block_revisions`, `page_publications` and `page_url_history` rows they
 * hold. Read-only; typed to accept a transaction handle too, so
 * `deletePagePermanently` recomputes this same impact inside its own
 * transaction rather than trusting a caller's earlier read.
 */
export async function computePagePermanentDeleteImpact(
  db: AuditDatabase,
  input: { readonly pageId: string },
): Promise<PagePermanentDeleteImpact> {
  const subtree = await selectSubtree(db, input);
  const ids = subtree.map((page) => page.id);

  const [blockCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageBlocks)
    .where(
      and(eq(pageBlocks.ownerType, 'page'), inArray(pageBlocks.ownerId, ids)),
    );
  const [revisionCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blockRevisions)
    .where(
      and(
        eq(blockRevisions.ownerType, 'page'),
        inArray(blockRevisions.ownerId, ids),
      ),
    );
  const [publicationCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pagePublications)
    .where(inArray(pagePublications.pageId, ids));
  const [urlHistoryCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageUrlHistory)
    .where(inArray(pageUrlHistory.pageId, ids));

  return {
    pageId: input.pageId,
    pageCount: subtree.length,
    blockCount: blockCountRow?.count ?? 0,
    blockRevisionCount: revisionCountRow?.count ?? 0,
    publicationCount: publicationCountRow?.count ?? 0,
    urlHistoryCount: urlHistoryCountRow?.count ?? 0,
  };
}

export type DeletePagePermanentlyInput = {
  readonly pageId: string;
  readonly baseVersion: number;
};

/**
 * Permanently deletes a page and its whole subtree (D-24, RESEARCH Pitfall
 * 1), for a role holding the distinct `pages:delete-permanent` permission.
 * Version-checked first; recomputes `computePagePermanentDeleteImpact`
 * INSIDE this same transaction (never trusting the pre-transaction read
 * used for the audit `before`); collects the page and its descendants by
 * path prefix `FOR UPDATE`; then deletes in the SAME order `purgeLocale`
 * (`locale.ts`) uses, so the two deleters in this package can never
 * disagree:
 *
 * 1. `page_url_history` -- one final `deleted` row per previously
 *    published page, appended BEFORE the delete so the address survives
 *    the page it named (Phase 16 reads this). This insert is the reason
 *    `pages` must be deleted LAST, not merely a stylistic ordering choice:
 *    a live discrimination check confirmed that deleting `pages` first
 *    trips `page_url_history_page_id_fk` the moment this insert runs
 *    against a `page_id` that no longer exists.
 * 2. `page_publications`, after clearing `pages.live_publication_id` on
 *    the collected rows -- defensive, matching `locale.ts`'s `purgeLocale`
 *    precedent, though `pages_live_publication_id_fk`'s own `ON DELETE SET
 *    NULL` already nulls it automatically once the referenced row is gone.
 * 3. `block_revisions` where `owner_type = 'page'` and `owner_id` is one
 *    of the collected ids -- EXPLICITLY, because that column carries no
 *    foreign key and no database cascade reaches it (RESEARCH Pitfall
 *    1/3).
 * 4. `page_blocks` where `owner_type = 'page'` and `owner_id` is one of
 *    the collected ids.
 * 5. `pages`, one statement per row, deepest path first -- never a single
 *    batched multi-row delete here, since `parent_page_id`'s `ON DELETE
 *    RESTRICT` would otherwise risk firing against a child row not yet
 *    processed within the same statement.
 *
 * Returns the recomputed counts as both the result and the audit `after`
 * payload. Runs through `deps.recorder.run` (`pages:delete-permanent` /
 * `page.delete-permanent`).
 */
export async function deletePagePermanently(
  deps: PagesDeps,
  actor: AuditActor,
  input: DeletePagePermanentlyInput,
): Promise<PagePermanentDeleteImpact> {
  const now = deps.now ?? (() => new Date());
  const impactCounts = await computePagePermanentDeleteImpact(deps.db, {
    pageId: input.pageId,
  });

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:delete-permanent',
      action: 'page.delete-permanent',
      entityType: 'page',
      entityId: input.pageId,
      before: impactCounts,
    },
    async (tx) => {
      const current = await loadPageForUpdate(tx, input.pageId);
      if (current.version !== input.baseVersion) {
        throw new StalePageVersionError(
          current.id,
          input.baseVersion,
          current.version,
        );
      }

      const subtree = await selectSubtreeForUpdate(
        tx,
        current.locale,
        current.path,
      );
      const impact = await computePagePermanentDeleteImpact(tx, {
        pageId: input.pageId,
      });
      const ids = subtree.map((page) => page.id);

      const deletedAt = now();
      for (const row of subtree) {
        if (row.resolvedPath !== null) {
          await recordPageUrlHistory(tx, {
            pageId: row.id,
            translationGroup: row.translationGroup,
            locale: row.locale,
            oldPath: row.resolvedPath,
            reason: 'deleted',
            changedAt: deletedAt,
          });
        }
      }

      await tx
        .update(pages)
        .set({ livePublicationId: null })
        .where(inArray(pages.id, ids));
      await tx
        .delete(pagePublications)
        .where(inArray(pagePublications.pageId, ids));

      await tx
        .delete(blockRevisions)
        .where(
          and(
            eq(blockRevisions.ownerType, 'page'),
            inArray(blockRevisions.ownerId, ids),
          ),
        );

      await tx
        .delete(pageBlocks)
        .where(
          and(
            eq(pageBlocks.ownerType, 'page'),
            inArray(pageBlocks.ownerId, ids),
          ),
        );

      const deepestFirst = [...subtree].sort(
        (a, b) => b.path.length - a.path.length,
      );
      for (const row of deepestFirst) {
        await tx.delete(pages).where(eq(pages.id, row.id));
      }

      return { result: impact, after: impact };
    },
  );
}
