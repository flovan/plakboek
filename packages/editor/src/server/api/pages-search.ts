/**
 * The editor API's page search, behind the same gate as every other route. It
 * backs the link picker: the pages of one locale whose title or path contains
 * the text, as titles and addresses only, never content. A locale the
 * installation does not declare is refused rather than searched.
 */
import { searchPages } from '@plakboek/pages';
import type { PageSearchResponse } from '../../api-types.js';
import { ApiHttpError } from './http.js';
import type { ApiContext } from './session.js';

export type PageSearchInput = {
  readonly locale: string;
  readonly q: string;
};

export async function searchPagesRoute(
  context: ApiContext,
  input: PageSearchInput,
): Promise<PageSearchResponse> {
  const { pages, homeSlug } = context.deps;
  const { locales, defaultLocale } = pages.config.content;
  if (!locales.includes(input.locale)) {
    throw new ApiHttpError(400, 'invalid-request');
  }
  const results = await searchPages(pages.db, {
    locale: input.locale,
    query: input.q,
    defaultLocale,
    homeSlug,
  });
  return { ok: true, results };
}
