/**
 * The single-row, project-wide page engine settings (D-40): the page
 * edit-lock toggle and the URL pattern, seeded by `0003_page_block_engine`'s
 * migration, read here and never per page or per content type. Mirrors
 * `@plakboek/content`'s `settings.ts` read shape.
 *
 * This module ships only reads and the type they return. The page-lock
 * toggle's writer belongs to plan 04-14; the URL pattern's audited writer
 * (`setPageUrlPattern`) lives in `page-routing.ts`, which locks this same
 * row `FOR UPDATE` directly rather than through a helper here, since it
 * needs to hold the lock across its own multi-step transaction.
 */
import type { AuditDatabase } from '@plakboek/auth';
import { eq } from 'drizzle-orm';
import { pageEngineSettings } from './schema.js';

const SETTINGS_ROW_ID = 1;

export type PageEngineSettings = {
  readonly pageEditLocking: boolean;
  readonly urlPattern: string;
  readonly updatedAt: Date;
};

/** Thrown by `getPageEngineSettings` when the single seeded row is absent --
 * a database that skipped (or somehow lost) `0003_page_block_engine`'s seed
 * fails loudly here rather than silently falling back to a default that
 * could disagree with what a later write stores (T-04-48). */
export class PageEngineSettingsMissingError extends Error {
  constructor() {
    super(
      '[@plakboek/pages] page_engine_settings has no row -- did the 0003_page_block_engine migration seed run?',
    );
    this.name = 'PageEngineSettingsMissingError';
  }
}

/**
 * Reads the single project-wide page engine settings row (`id = 1`).
 * Accepts a plain database handle or an open transaction (`AuditDatabase`
 * covers both, matching every other read in this package). Throws
 * `PageEngineSettingsMissingError` rather than defaulting when the row is
 * missing.
 */
export async function getPageEngineSettings(
  db: AuditDatabase,
): Promise<PageEngineSettings> {
  const [row] = await db
    .select({
      pageEditLocking: pageEngineSettings.pageEditLocking,
      urlPattern: pageEngineSettings.urlPattern,
      updatedAt: pageEngineSettings.updatedAt,
    })
    .from(pageEngineSettings)
    .where(eq(pageEngineSettings.id, SETTINGS_ROW_ID))
    .limit(1);
  if (row === undefined) {
    throw new PageEngineSettingsMissingError();
  }
  return row;
}

/** Reads just the stored page URL pattern -- the value every `resolved_path`
 * materialisation and every pattern-change impact report is computed
 * against. */
export async function getPageUrlPattern(db: AuditDatabase): Promise<string> {
  const settings = await getPageEngineSettings(db);
  return settings.urlPattern;
}
