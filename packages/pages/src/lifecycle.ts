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
import type { AuditActor } from '@plakboek/auth';
import { and, eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import {
  getPage,
  loadPageForUpdate,
  recordPageUrlHistory,
  toPageRecord,
  StalePageVersionError,
} from './pages.js';
import { pages } from './schema.js';
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
