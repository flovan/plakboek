/**
 * Page lookups for links (D-18): a locale-scoped search for the page picker
 * and a batched page-id-to-public-path resolver for rendering.
 *
 * A link stores a page row id, so a slug or hierarchy change never breaks it.
 * The renderer is synchronous, so a render resolves every stored id in one
 * batch before it starts (`resolvePageLinkPaths`), the same shape as asset
 * url resolution.
 */
import type { AuditDatabase } from '@plakboek/auth';
import { and, asc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { pages } from './schema.js';
import { getPageUrlPattern } from './settings.js';
import { toPublicPagePath } from './public-path.js';

/** The most results one search returns. */
export const PAGE_SEARCH_LIMIT = 20;

/** The longest search query accepted; callers refuse anything longer. */
export const PAGE_SEARCH_QUERY_MAX_LENGTH = 200;

export type PageSearchResult = {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly publicPath: string;
  /** True when the page has a published version visitors can reach. */
  readonly live: boolean;
};

export type SearchPagesInput = {
  readonly locale: string;
  readonly query: string;
  readonly defaultLocale: string;
  readonly homeSlug: string;
};

/** Escapes `\`, `%` and `_` so a query matches only its own literal text. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Finds the pages of one locale whose title or path contains `query`
 * (case-insensitive, literal). A trashed page is never returned; an
 * unpublished page is, flagged `live: false`. An empty query lists the first
 * pages by title. At most `PAGE_SEARCH_LIMIT` results, ordered by title.
 */
export async function searchPages(
  db: AuditDatabase,
  input: SearchPagesInput,
): Promise<readonly PageSearchResult[]> {
  const query = input.query.trim();
  const conditions = [
    eq(pages.locale, input.locale),
    ne(pages.status, 'trashed'),
  ];
  if (query.length > 0) {
    const pattern = `%${escapeLikePattern(query)}%`;
    const match = or(
      sql`${pages.title} ILIKE ${pattern} ESCAPE '\\'`,
      sql`${pages.path} ILIKE ${pattern} ESCAPE '\\'`,
    );
    if (match !== undefined) conditions.push(match);
  }

  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      path: pages.path,
      livePublicationId: pages.livePublicationId,
    })
    .from(pages)
    .where(and(...conditions))
    .orderBy(asc(pages.title), asc(pages.id))
    .limit(PAGE_SEARCH_LIMIT);

  if (rows.length === 0) return [];

  const urlPattern = await getPageUrlPattern(db);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    path: row.path,
    publicPath: toPublicPagePath(urlPattern, {
      locale: input.locale,
      defaultLocale: input.defaultLocale,
      path: row.path,
      homeSlug: input.homeSlug,
    }),
    live: row.livePublicationId !== null,
  }));
}

export type ResolvePageLinkPathsInput = {
  readonly pageIds: readonly string[];
  readonly defaultLocale: string;
  readonly homeSlug: string;
  /** Leave out pages that are not live, so a visitor link never points at an
   * unpublished page. */
  readonly liveOnly: boolean;
};

/**
 * Turns stored page ids into public paths, in at most two statements (the
 * URL pattern, then the pages) and none when there are no ids. Unknown and
 * trashed ids are absent from the result, as are pages that are not live
 * when `liveOnly` is set.
 */
export async function resolvePageLinkPaths(
  db: AuditDatabase,
  input: ResolvePageLinkPathsInput,
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(input.pageIds)];
  const resolved = new Map<string, string>();
  if (ids.length === 0) return resolved;

  const urlPattern = await getPageUrlPattern(db);
  const conditions = [inArray(pages.id, ids), ne(pages.status, 'trashed')];
  if (input.liveOnly) conditions.push(isNotNull(pages.livePublicationId));

  const rows = await db
    .select({ id: pages.id, locale: pages.locale, path: pages.path })
    .from(pages)
    .where(and(...conditions));

  for (const row of rows) {
    resolved.set(
      row.id,
      toPublicPagePath(urlPattern, {
        locale: row.locale,
        defaultLocale: input.defaultLocale,
        path: row.path,
        homeSlug: input.homeSlug,
      }),
    );
  }
  return resolved;
}
