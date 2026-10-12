/**
 * The editor-facing read of a page by public path (Phase 7 D-20): what the
 * `_edit` render needs, beside `visitor.ts`'s published read.
 *
 * The visitor resolver answers "what may a visitor see at this path" from the
 * frozen publication, so a draft-only page does not exist for it. The editor
 * needs the opposite: the page's live working tree, unpublished changes
 * included, for any page that is not in the trash. This module therefore
 * shares the visitor resolver's address mapping (the stored URL pattern and
 * `matchPublicPagePath`, so the same redirects and misses) and swaps only the
 * last step: the page row is found by `(locale, path)` -- `resolved_path` is
 * NULL unless a page is published -- and its tree is read with
 * `readBlockTree`. `page_publications` is never touched.
 *
 * Not permission-gated, like `getPage`: the caller (the editor's server entry)
 * decides who may ask. It must never be wired to a visitor path, because it
 * returns unpublished content.
 */
import type { AuditDatabase } from '@plakboek/auth';
import type { PagesHooks } from './config.js';
import {
  PageUrlPatternError,
  parsePageUrlPattern,
  type ParsedPageUrlPattern,
} from './page-url-pattern.js';
import { getPageByPath } from './pages.js';
import {
  matchPublicPagePath,
  type MatchPublicPagePathInput,
} from './public-path.js';
import { toPublishedPageSeo, type PublishedPageSeo } from './publish.js';
import { getPageUrlPattern } from './settings.js';
import { readBlockTree } from './tree.js';
import type { BlockNode, PageStatus } from './types.js';

export type ResolveEditablePageInput = MatchPublicPagePathInput;

/** What an editor needs of a page to render and edit it: the identity and
 * version the structural writes check, the status, and the head SEO set read
 * from the live row (not from a snapshot). */
export type EditablePageView = {
  readonly id: string;
  readonly locale: string;
  readonly path: string;
  readonly title: string;
  readonly status: PageStatus;
  readonly version: number;
  readonly livePublicationId: string | null;
  readonly seo: PublishedPageSeo;
};

export type EditablePageResolution =
  | {
      readonly kind: 'page';
      readonly publicPath: string;
      readonly page: EditablePageView;
      readonly blocks: readonly BlockNode[];
    }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'not-found' }
  /** The stored pattern no longer parses; nothing can be addressed. Reported
   * by the caller, never thrown per request (same contract as the visitor
   * resolver). */
  | {
      readonly kind: 'invalid-pattern';
      readonly error: PageUrlPatternError;
    };

/**
 * Resolves a public URL path to the page's live working tree: the stored URL
 * pattern, the pure public-path mapping, then one indexed page read and one
 * recursive tree read. A draft, scheduled or published page resolves; a
 * trashed one and a locale that is no longer enabled do not. A block of a type
 * the config no longer declares comes back as a degraded node and is reported
 * once through `hooks.onDegradedBlock`.
 */
export async function resolveEditablePage(
  db: AuditDatabase,
  input: ResolveEditablePageInput,
  hooks?: PagesHooks,
): Promise<EditablePageResolution> {
  const pattern = await getPageUrlPattern(db);
  let parsed: ParsedPageUrlPattern;
  try {
    parsed = parsePageUrlPattern(pattern);
  } catch (error) {
    if (error instanceof PageUrlPatternError) {
      return { kind: 'invalid-pattern', error };
    }
    throw error;
  }
  const matched = matchPublicPagePath(parsed, input);
  if (matched.kind === 'redirect') {
    return { kind: 'redirect', location: matched.location };
  }
  if (matched.kind === 'none') return { kind: 'not-found' };

  const page = await getPageByPath(db, {
    locale: matched.locale,
    path: matched.path,
  });
  if (page === null || page.status === 'trashed') {
    return { kind: 'not-found' };
  }

  const blocks = await readBlockTree(
    db,
    { ownerType: 'page', ownerId: page.id, locale: page.locale },
    hooks,
  );
  return {
    kind: 'page',
    publicPath: matched.publicPath,
    page: {
      id: page.id,
      locale: page.locale,
      path: page.path,
      title: page.title,
      status: page.status,
      version: page.version,
      livePublicationId: page.livePublicationId,
      seo: toPublishedPageSeo(page.seo),
    },
    blocks,
  };
}
