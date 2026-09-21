/**
 * Boot-time locale safety net (D-24, D-25): a host can change which locales
 * are enabled while stored content still holds rows in a locale that is no
 * longer among them. `checkContentLocales` never deletes or rewrites those
 * rows -- it only reports them, once, through a warning hook that can never
 * crash the boot sequence it runs during (T-03-50). Reads and writes across
 * the rest of this package treat a removed-locale row as frozen: excluded
 * from `findEntry`/`listEntries`/`findTranslations`/the singleton reads, and
 * refused for every write via `loadEntryForUpdate`/
 * `lockTranslationGroupForUpdate` (`entries.ts`).
 */
import { sql } from 'drizzle-orm';
import type { ContentDeps, LocaleRemovedEvent } from './config.js';
import { reportContentWarning } from './config.js';
import { contentEntries } from './schema.js';

function defaultOnLocaleRemoved(event: LocaleRemovedEvent): void {
  const plural = event.entryCount === 1 ? 'entry' : 'entries';
  // oxlint-disable-next-line no-console -- documented default fallback hook (D-24); a host overrides `onLocaleRemoved` to route elsewhere
  console.warn(
    `[@plakboek/content] locale "${event.locale}" was removed from ContentConfig but ${event.entryCount} ${plural} still exist -- content kept, excluded from reads, refused for writes`,
  );
}

export type LocaleCheckReport = {
  readonly removedLocales: readonly {
    readonly locale: string;
    readonly entryCount: number;
  }[];
};

/**
 * Compares stored `content_entries` locales against
 * `deps.config.locales` (D-24, D-25) with one grouped count query. For each
 * locale present in stored data but not among `deps.config.locales`, reports
 * it through `reportContentWarning(deps.hooks?.onLocaleRemoved,
 * defaultOnLocaleRemoved, event)` -- a hook that throws or returns a
 * rejected promise never escapes here, so a broken host hook can never crash
 * boot -- and returns a report listing every removed locale and its entry
 * count. Never deletes or rewrites anything: call this once at boot,
 * database errors aside (boot cannot continue without the database, so
 * those propagate).
 */
export async function checkContentLocales(
  deps: ContentDeps,
): Promise<LocaleCheckReport> {
  const rows = await deps.db
    .select({
      locale: contentEntries.locale,
      entryCount: sql<number>`count(*)::int`,
    })
    .from(contentEntries)
    .groupBy(contentEntries.locale);

  const removedLocales = rows.filter(
    (row) => !deps.config.locales.includes(row.locale),
  );

  const now = deps.now ?? (() => new Date());
  const occurredAt = now();

  for (const removed of removedLocales) {
    reportContentWarning<LocaleRemovedEvent>(
      deps.hooks?.onLocaleRemoved,
      defaultOnLocaleRemoved,
      {
        locale: removed.locale,
        entryCount: removed.entryCount,
        occurredAt,
      },
    );
  }

  return Object.freeze({
    removedLocales: Object.freeze(
      removedLocales.map((row) =>
        Object.freeze({ locale: row.locale, entryCount: row.entryCount }),
      ),
    ),
  });
}
