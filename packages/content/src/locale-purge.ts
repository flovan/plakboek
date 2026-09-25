/**
 * A public, audited, locale-scoped entry purge (D-37). `checkContentLocales`
 * (`locales.ts`) only ever reports a removed locale's rows -- nothing in this
 * package deletes them as a side effect of boot or of a config change. This
 * module is the one deliberate, permission-gated exception: an editor who
 * holds `entries:delete-permanent` can ask "what would purging locale X
 * delete" (`computeLocalePurgeEntriesImpact`, read-only) and then actually do
 * it (`purgeLocaleEntries`).
 *
 * `@plakboek/pages` needs the same operation to reach entries as part of its
 * own cross-package `purgeLocale` (04-12's Task 2): rather than reach around
 * this package's barrel at a Drizzle table, it calls
 * `purgeLocaleEntriesInTransaction` -- the same body with no audited-run
 * wrapper of its own -- inside its own transaction, so the two engines'
 * deletes commit or roll back together. That function takes a transaction
 * handle as its first parameter, so (mirroring this package's other
 * transaction-first exceptions) its caller owns the audit record: `@plakboek/
 * pages`'s `purgeLocale` writes the one audit row for the whole cross-package
 * operation, not this module.
 *
 * A reference from a surviving locale's entry to a translation group that
 * this purge empties entirely is stripped the same way
 * `lifecycle.ts`'s `deleteEntryPermanently` strips one on a single-entry
 * delete (D-38, D-39, D-40): a translation group with a surviving row in
 * another locale is untouched, because a reference targets the group, not a
 * locale row, and the group still legitimately exists.
 */
import type {
  AuditActor,
  AuditDatabase,
  AuditTransaction,
} from '@plakboek/auth';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import { stripTranslationGroupFromReferences } from './references.js';
import {
  contentEntries,
  contentEntryReferences,
  contentEntryUrlHistory,
  entryRevisions,
} from './schema.js';

export type LocalePurgeEntriesInput = { readonly locale: string };

/** What purging (or previewing the purge of) one locale's entries touches
 * (D-37). `translationGroupsAffected` counts every distinct translation
 * group holding a row in this locale, whether or not that group survives in
 * another locale afterwards; `referenceCount` counts both directions: rows
 * naming a purged entry as their source (cascade-deleted with it) and rows
 * naming a translation group this purge empties entirely as their target
 * (stripped). */
export type LocalePurgeEntriesImpact = {
  readonly locale: string;
  readonly entryCount: number;
  readonly revisionCount: number;
  readonly urlHistoryCount: number;
  readonly referenceCount: number;
  readonly translationGroupsAffected: number;
};

type LocalePurgeContext = {
  readonly impact: LocalePurgeEntriesImpact;
  readonly entryIds: readonly string[];
  readonly emptiedGroups: readonly string[];
};

function zeroImpact(locale: string): LocalePurgeEntriesImpact {
  return Object.freeze({
    locale,
    entryCount: 0,
    revisionCount: 0,
    urlHistoryCount: 0,
    referenceCount: 0,
    translationGroupsAffected: 0,
  });
}

/**
 * Loads everything a purge (preview or write) of `locale` needs in one
 * place: the impact counts, which entry ids that locale holds, and which of
 * their translation groups this purge would empty entirely (no surviving row
 * in another locale). Accepts `db` or a transaction, so
 * `computeLocalePurgeEntriesImpact` and `purgeLocaleEntriesInTransaction`
 * read this exactly the same way -- the only difference between a preview
 * and a write is whether anything runs after it.
 */
async function loadLocalePurgeContext(
  db: AuditDatabase,
  locale: string,
): Promise<LocalePurgeContext> {
  const entryRows = await db
    .select({
      id: contentEntries.id,
      translationGroup: contentEntries.translationGroup,
    })
    .from(contentEntries)
    .where(eq(contentEntries.locale, locale));

  const entryIds = entryRows.map((row) => row.id);
  if (entryIds.length === 0) {
    return { impact: zeroImpact(locale), entryIds: [], emptiedGroups: [] };
  }

  const groupIds = [...new Set(entryRows.map((row) => row.translationGroup))];

  const [revisionCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entryRevisions)
    .where(inArray(entryRevisions.entryId, entryIds));

  const [urlHistoryCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntryUrlHistory)
    .where(eq(contentEntryUrlHistory.locale, locale));

  const survivingGroupRows = await db
    .select({ translationGroup: contentEntries.translationGroup })
    .from(contentEntries)
    .where(
      and(
        inArray(contentEntries.translationGroup, groupIds),
        ne(contentEntries.locale, locale),
      ),
    )
    .groupBy(contentEntries.translationGroup);
  const survivingGroups = new Set(
    survivingGroupRows.map((row) => row.translationGroup),
  );
  const emptiedGroups = groupIds.filter((group) => !survivingGroups.has(group));

  const [outgoingReferenceCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentEntryReferences)
    .where(inArray(contentEntryReferences.sourceEntryId, entryIds));

  let incomingReferenceCount = 0;
  if (emptiedGroups.length > 0) {
    const [incomingReferenceCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentEntryReferences)
      .where(
        inArray(contentEntryReferences.targetTranslationGroup, emptiedGroups),
      );
    incomingReferenceCount = incomingReferenceCountRow?.count ?? 0;
  }

  return {
    impact: Object.freeze({
      locale,
      entryCount: entryIds.length,
      revisionCount: revisionCountRow?.count ?? 0,
      urlHistoryCount: urlHistoryCountRow?.count ?? 0,
      referenceCount:
        (outgoingReferenceCountRow?.count ?? 0) + incomingReferenceCount,
      translationGroupsAffected: groupIds.length,
    }),
    entryIds,
    emptiedGroups,
  };
}

/**
 * Reports what purging `input.locale`'s entries would touch (D-37):
 * entry, revision, URL-history and reference-row counts, computed with one
 * query per counted relation. A translation group's other locales are
 * untouched by the count -- purging `nl` reports only the `nl` row of a
 * group that also holds an `en` row. Read-only; writes nothing.
 */
export async function computeLocalePurgeEntriesImpact(
  db: AuditDatabase,
  input: LocalePurgeEntriesInput,
): Promise<LocalePurgeEntriesImpact> {
  const context = await loadLocalePurgeContext(db, input.locale);
  return context.impact;
}

/**
 * The shared purge body, with no audited run of its own (D-37,
 * RESEARCH Pitfall 5): recomputes the impact fresh against `tx` -- not a
 * value read before this transaction opened -- then, only for a translation
 * group this purge empties entirely, strips it from every reference that
 * names it (reusing `lifecycle.ts`'s `stripTranslationGroupFromReferences`),
 * deletes the locale's `content_entry_url_history` rows, then deletes the
 * locale's `content_entries` rows, letting the existing `entry_revisions`
 * and `content_entry_references` (source side) cascades remove the rest.
 * Returns the impact it recomputed at the start -- a record of exactly what
 * this call deleted, not a stale earlier read.
 *
 * Exported (not internal, unlike this package's other transaction-scoped
 * writers) because `@plakboek/pages`'s `purgeLocale` calls it inside its own
 * transaction, so a page-engine purge and this entry purge commit or roll
 * back together. A caller using this function directly owns the audit
 * record for the whole operation it's part of; `purgeLocaleEntries` below is
 * the audited door for calling it on its own.
 */
export async function purgeLocaleEntriesInTransaction(
  tx: AuditTransaction,
  input: LocalePurgeEntriesInput,
): Promise<LocalePurgeEntriesImpact> {
  const context = await loadLocalePurgeContext(tx, input.locale);

  for (const group of context.emptiedGroups) {
    await stripTranslationGroupFromReferences(tx, {
      translationGroup: group,
      changedAt: new Date(),
      changedBy: null,
    });
  }

  if (context.entryIds.length > 0) {
    await tx
      .delete(contentEntryUrlHistory)
      .where(eq(contentEntryUrlHistory.locale, input.locale));
    await tx
      .delete(contentEntries)
      .where(eq(contentEntries.locale, input.locale));
  }

  return context.impact;
}

/**
 * Purges every `content_entries` row (and its revisions, URL history and
 * reference rows) in `input.locale`, for an actor holding
 * `entries:delete-permanent` (D-37). `before` carries a pre-transaction
 * impact snapshot for the audit row's identifying context; the actual
 * write recomputes the impact fresh inside its own transaction
 * (`purgeLocaleEntriesInTransaction`) and returns those recomputed counts as
 * both the result and the audit `after` -- the report is a record of the
 * write, not of this earlier read. Runs through this package's audited-run
 * pattern (`entries:delete-permanent` / `locale.purge-entries`); an actor lacking
 * the permission gets `PermissionDeniedError` and a denied audit row, and
 * nothing is deleted. Purging a locale with no rows succeeds, reports
 * zeroes, and still records one audit row.
 */
export async function purgeLocaleEntries(
  deps: ContentDeps,
  actor: AuditActor,
  input: LocalePurgeEntriesInput,
): Promise<LocalePurgeEntriesImpact> {
  const impactCounts = await computeLocalePurgeEntriesImpact(deps.db, input);

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:delete-permanent',
      action: 'locale.purge-entries',
      entityType: 'content_locale',
      entityId: input.locale,
      before: impactCounts,
    },
    async (tx) => {
      const result = await purgeLocaleEntriesInTransaction(tx, input);
      return { result, after: result };
    },
  );
}
