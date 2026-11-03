/**
 * The editor API's page search, behind the same gate as every other route. It
 * backs the link picker: the pages of one locale whose title or path contains
 * the text, as titles and addresses only, never content. A locale the
 * installation does not declare is refused rather than searched.
 *
 * With `id` the answer is that one page, under the same rules as a search (the
 * locale's pages only, never a trashed one), or nothing: the link popover asks
 * it to tell a link whose page is gone from one whose page merely is not in the
 * first twenty results.
 */
import {
  getPage,
  getPageUrlPattern,
  searchPages,
  toPublicPagePath,
} from '@plakboek/pages';
import type { PageSearchResponse } from '../../api-types.js';
import { ApiHttpError } from './http.js';
import type { ApiContext } from './session.js';

export type PageSearchInput = {
  readonly locale: string;
  readonly q: string;
  /** Look up this one page instead of searching. */
  readonly id?: string | undefined;
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
  if (input.id !== undefined) {
    const page = await getPage(pages.db, input.id);
    if (
      page === null ||
      page.locale !== input.locale ||
      page.status === 'trashed'
    ) {
      return { ok: true, results: [] };
    }
    const pattern = await getPageUrlPattern(pages.db);
    return {
      ok: true,
      results: [
        {
          id: page.id,
          title: page.title,
          path: page.path,
          publicPath: toPublicPagePath(pattern, {
            locale: page.locale,
            defaultLocale,
            path: page.path,
            homeSlug,
          }),
          live: page.livePublicationId !== null,
        },
      ],
    };
  }
  const results = await searchPages(pages.db, {
    locale: input.locale,
    query: input.q,
    defaultLocale,
    homeSlug,
  });
  return { ok: true, results };
}
