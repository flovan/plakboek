/**
 * Boot-time page locale safety net and the cross-package locale purge
 * (D-37). Mirrors `@plakboek/content`'s `locales.ts`: `checkPageLocales`
 * never deletes or rewrites a removed locale's rows -- it only reports
 * them, once, through a warning hook that can never crash the boot sequence
 * it runs during. `purgeLocale` is the one deliberate, permission-gated
 * exception: an actor holding both `pages:delete-permanent` and
 * `entries:delete-permanent` can ask "what would purging locale X delete"
 * (`computeLocalePurgeImpact`, read-only) and then actually do it, across
 * both the page engine and `@plakboek/content`'s entries, in one shared
 * transaction.
 */
import {
  PermissionDeniedError,
  type AuditActor,
  type AuditMutationContext,
} from '@plakboek/auth';
import {
  computeLocalePurgeEntriesImpact,
  purgeLocaleEntriesInTransaction,
  type LocalePurgeEntriesImpact,
} from '@plakboek/content';
import type { Permission } from '@plakboek/permissions';
import { eq, sql } from 'drizzle-orm';
import type { AuditDatabase, AuditTransaction } from '@plakboek/auth';
import type { LocaleRemovedEvent, PagesConfig, PagesDeps } from './config.js';
import { reportPagesWarning } from './config.js';
import { registerGlobalPurge } from './purge.js';
import {
  blockRevisions,
  pageBlocks,
  pagePublications,
  pages,
  pageUrlHistory,
} from './schema.js';

function defaultOnPageLocaleRemoved(event: LocaleRemovedEvent): void {
  const plural = event.pageCount === 1 ? 'page' : 'pages';
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-37); a host overrides `onLocaleRemoved` to route elsewhere
  console.warn(
    `[@plakboek/pages] locale "${event.locale}" was removed from PagesConfig but ${event.pageCount} ${plural} still exist -- pages kept, excluded from reads, refused for writes`,
  );
}

/** What a removed locale still holds across every page-engine table
 * (D-37). */
export type PageLocaleCounts = {
  readonly locale: string;
  readonly pageCount: number;
  readonly blockCount: number;
  readonly blockRevisionCount: number;
  readonly publicationCount: number;
  readonly urlHistoryCount: number;
};

function toLocaleCountMap(
  rows: readonly { readonly locale: string; readonly count: number }[],
): ReadonlyMap<string, number> {
  return new Map(rows.map((row) => [row.locale, row.count]));
}

/**
 * Compares stored `pages`/`page_blocks`/`block_revisions`/
 * `page_publications`/`page_url_history` locales against
 * `config.content.locales` (D-37), one grouped query per table. Returns a
 * `PageLocaleCounts` row for every locale present in stored data but not
 * among the enabled ones. Never deletes or rewrites anything: call this
 * once at boot alongside `reportPageLocaleRemoval`, database errors aside.
 */
export async function checkPageLocales(
  db: AuditDatabase,
  config: PagesConfig,
): Promise<readonly PageLocaleCounts[]> {
  const pageRows = await db
    .select({ locale: pages.locale, count: sql<number>`count(*)::int` })
    .from(pages)
    .groupBy(pages.locale);
  const blockRows = await db
    .select({ locale: pageBlocks.locale, count: sql<number>`count(*)::int` })
    .from(pageBlocks)
    .groupBy(pageBlocks.locale);
  const revisionRows = await db
    .select({
      locale: blockRevisions.locale,
      count: sql<number>`count(*)::int`,
    })
    .from(blockRevisions)
    .groupBy(blockRevisions.locale);
  const publicationRows = await db
    .select({
      locale: pagePublications.locale,
      count: sql<number>`count(*)::int`,
    })
    .from(pagePublications)
    .groupBy(pagePublications.locale);
  const urlHistoryRows = await db
    .select({
      locale: pageUrlHistory.locale,
      count: sql<number>`count(*)::int`,
    })
    .from(pageUrlHistory)
    .groupBy(pageUrlHistory.locale);

  const pageCounts = toLocaleCountMap(pageRows);
  const blockCounts = toLocaleCountMap(blockRows);
  const revisionCounts = toLocaleCountMap(revisionRows);
  const publicationCounts = toLocaleCountMap(publicationRows);
  const urlHistoryCounts = toLocaleCountMap(urlHistoryRows);

  const allLocales = new Set<string>([
    ...pageCounts.keys(),
    ...blockCounts.keys(),
    ...revisionCounts.keys(),
    ...publicationCounts.keys(),
    ...urlHistoryCounts.keys(),
  ]);
  const removedLocales = [...allLocales]
    .filter((locale) => !config.content.locales.includes(locale))
    .sort();

  return Object.freeze(
    removedLocales.map((locale) =>
      Object.freeze({
        locale,
        pageCount: pageCounts.get(locale) ?? 0,
        blockCount: blockCounts.get(locale) ?? 0,
        blockRevisionCount: revisionCounts.get(locale) ?? 0,
        publicationCount: publicationCounts.get(locale) ?? 0,
        urlHistoryCount: urlHistoryCounts.get(locale) ?? 0,
      }),
    ),
  );
}

/**
 * Fires `reportPagesWarning(deps.hooks?.onLocaleRemoved, ...)` once per
 * `checkPageLocales` result row -- a broken host hook can never crash boot.
 * This function contains no delete of any kind: nothing is ever purged as a
 * side effect of boot or of a config change (D-37).
 */
export function reportPageLocaleRemoval(
  deps: PagesDeps,
  counts: readonly PageLocaleCounts[],
): void {
  const now = deps.now ?? (() => new Date());
  const occurredAt = now();
  for (const entry of counts) {
    reportPagesWarning<LocaleRemovedEvent>(
      deps.hooks?.onLocaleRemoved,
      defaultOnPageLocaleRemoved,
      { locale: entry.locale, pageCount: entry.pageCount, occurredAt },
    );
  }
}

/** Reads one locale's page-engine counts directly (not the grouped,
 * all-locales shape `checkPageLocales` returns) -- the shape
 * `computeLocalePurgeImpact`/`purgeLocale` need for a single, already-known
 * target locale. */
async function countPageLocale(
  db: AuditDatabase,
  locale: string,
): Promise<PageLocaleCounts> {
  const [pageRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(eq(pages.locale, locale));
  const [blockRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageBlocks)
    .where(eq(pageBlocks.locale, locale));
  const [revisionRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blockRevisions)
    .where(eq(blockRevisions.locale, locale));
  const [publicationRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pagePublications)
    .where(eq(pagePublications.locale, locale));
  const [urlHistoryRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageUrlHistory)
    .where(eq(pageUrlHistory.locale, locale));

  return Object.freeze({
    locale,
    pageCount: pageRow?.count ?? 0,
    blockCount: blockRow?.count ?? 0,
    blockRevisionCount: revisionRow?.count ?? 0,
    publicationCount: publicationRow?.count ?? 0,
    urlHistoryCount: urlHistoryRow?.count ?? 0,
  });
}

/** The combined page-engine and content-engine counts a locale purge would
 * touch (D-37). */
export type LocalePurgeReport = {
  readonly locale: string;
  readonly pages: PageLocaleCounts;
  readonly entries: LocalePurgeEntriesImpact;
};

export type ComputeLocalePurgeImpactInput = { readonly locale: string };

/**
 * Reports what purging `input.locale` would touch, across both engines
 * (D-37): the page-engine counts and `@plakboek/content`'s
 * `computeLocalePurgeEntriesImpact`. Read-only; writes nothing.
 */
export async function computeLocalePurgeImpact(
  deps: PagesDeps,
  input: ComputeLocalePurgeImpactInput,
): Promise<LocalePurgeReport> {
  const [pagesImpact, entries] = await Promise.all([
    countPageLocale(deps.db, input.locale),
    computeLocalePurgeEntriesImpact(deps.db, { locale: input.locale }),
  ]);
  return Object.freeze({ locale: input.locale, pages: pagesImpact, entries });
}

/** Thrown by `purgeLocale` when `input.locale` is still enabled in
 * `deps.config.content.locales` -- purging a live locale is not an
 * editorial act, it is an accident (D-37). */
export class LocaleStillEnabledError extends Error {
  readonly locale: string;

  constructor(locale: string) {
    super(
      `@plakboek/pages: cannot purge locale "${locale}" -- it is still enabled in PagesConfig`,
    );
    this.name = 'LocaleStillEnabledError';
    this.locale = locale;
  }
}

const ENTRIES_DELETE_PERMANENT_PERMISSION: Permission =
  'entries:delete-permanent';

export type PurgeLocaleInput = { readonly locale: string };

/**
 * Deletes every page, block, block revision, publication and URL-history
 * row in `input.locale`, and every entry `@plakboek/content` holds in it, in
 * one shared transaction (D-37). Refuses with `LocaleStillEnabledError`
 * before anything else when the locale is still enabled -- purging a live
 * locale is never legitimate. Then checks `entries:delete-permanent`
 * through `deps.resolver` directly (this operation spans both engines, so it
 * requires both permissions before the recorder's own
 * `pages:delete-permanent` check ever runs): missing it calls
 * `deps.recorder.recordDenied` and throws `PermissionDeniedError` before any
 * read or write.
 *
 * Runs through `deps.recorder.run` (`pages:delete-permanent` /
 * `locale.purge`). Inside the transaction: recomputes the page-engine counts
 * fresh, then deletes in dependency order -- `page_url_history`,
 * `page_publications` (clearing `pages.live_publication_id` first so the
 * foreign key does not block), `block_revisions`, `page_blocks`, then
 * `pages` -- then calls `purgeLocaleEntriesInTransaction` on the *same*
 * transaction so the two engines either both complete or both roll back.
 * Returns the recomputed counts from both engines.
 *
 * Deliberately lock-exempt (T-04-58): this deletes every page and block row
 * for a whole locale, project-wide -- not a single page's edit. It never
 * calls `assertPageWritable`. A per-page edit lock blocking a locale purge
 * would be impractical; the dual `pages:delete-permanent` +
 * `entries:delete-permanent` permission check above and the `recorder.run`
 * audit trail are this operation's own guard.
 */
export async function purgeLocale(
  deps: PagesDeps,
  actor: AuditActor,
  input: PurgeLocaleInput,
): Promise<LocalePurgeReport> {
  if (deps.config.content.locales.includes(input.locale)) {
    throw new LocaleStillEnabledError(input.locale);
  }

  const hasEntriesPermission = deps.resolver
    .resolve(actor.roleKey, { userId: actor.userId })
    .has(ENTRIES_DELETE_PERMANENT_PERMISSION);
  if (!hasEntriesPermission) {
    await deps.recorder.recordDenied(actor, {
      permission: ENTRIES_DELETE_PERMANENT_PERMISSION,
      action: 'locale.purge',
      entityType: 'locale',
      entityId: input.locale,
    });
    throw new PermissionDeniedError(
      ENTRIES_DELETE_PERMANENT_PERMISSION,
      actor.roleKey,
    );
  }

  const impactCounts = await computeLocalePurgeImpact(deps, input);

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:delete-permanent',
      action: 'locale.purge',
      entityType: 'locale',
      entityId: input.locale,
      before: impactCounts,
    },
    async (tx: AuditTransaction, context: AuditMutationContext) => {
      const pagesImpact = await countPageLocale(tx, input.locale);

      await tx
        .delete(pageUrlHistory)
        .where(eq(pageUrlHistory.locale, input.locale));
      await tx
        .update(pages)
        .set({ livePublicationId: null })
        .where(eq(pages.locale, input.locale));
      await tx
        .delete(pagePublications)
        .where(eq(pagePublications.locale, input.locale));
      await tx
        .delete(blockRevisions)
        .where(eq(blockRevisions.locale, input.locale));
      await tx.delete(pageBlocks).where(eq(pageBlocks.locale, input.locale));
      await tx.delete(pages).where(eq(pages.locale, input.locale));

      const entries = await purgeLocaleEntriesInTransaction(tx, {
        locale: input.locale,
      });

      const result: LocalePurgeReport = Object.freeze({
        locale: input.locale,
        pages: pagesImpact,
        entries,
      });
      registerGlobalPurge(deps, context);
      return { result, after: result };
    },
  );
}
