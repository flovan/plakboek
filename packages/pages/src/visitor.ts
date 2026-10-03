/**
 * The visitor-facing read side of the page engine (D-20..D-26): pure helpers
 * that map a public URL path to a page's stored address and back, and (below
 * them) the published-page lookup the render handler calls on a cache miss.
 *
 * It lives beside the writer of `resolved_path` so the two stay in one
 * package and one public-API test, and so the mapping between the two
 * spellings has exactly one home.
 *
 * Recorded rules:
 *
 * - `resolved_path` is read exactly as Phase 4 stores it (`en/about-us` under
 *   the default pattern); there is no migration and no change to its index or
 *   collision rules. The public spelling is derived here, nowhere else (D-23).
 * - The default locale is served without a locale prefix: `/about-us` is
 *   English, `/nl/over-ons` is Dutch. The prefixed spelling of the default
 *   locale (`/en/about-us`) is a redirect to the bare one (D-22).
 * - The locale root (`/`, `/nl`) is the published page whose hierarchy path is
 *   the configured home slug (`DEFAULT_HOME_SLUG`, `home`), because an empty
 *   hierarchy path is forbidden. The explicit `/home` spelling redirects to
 *   the locale root (D-26).
 * - The locale prefix wins over a default-locale page whose first segment
 *   equals an enabled locale code: an English page with slug `nl` would be
 *   unreachable at `/nl/...`. `publishPage` therefore refuses such a page with
 *   `PageAddressUnreachableError` (it is only checked at publish: enabling a
 *   locale later does not re-check pages that are already published).
 * - Under a pattern without `{locale}` only the default locale is
 *   addressable (the single-locale case the pattern parser documents).
 * - Only the enabled locales passed in are candidates, so a removed locale
 *   (rows kept, 03 D-25 / 04 D-37) can never match.
 * - Only pages resolve; content-entry URLs are not matched here (D-25).
 * - The previous-address history is never consulted: redirects over it are a
 *   later phase's (D-24).
 */
import type { AuditDatabase } from '@plakboek/auth';
import { and, eq } from 'drizzle-orm';
import {
  PageUrlPatternError,
  parsePageUrlPattern,
  type ParsedPageUrlPattern,
} from './page-url-pattern.js';
import {
  matchPublicPagePath,
  type MatchPublicPagePathInput,
} from './public-path.js';
import {
  asPageSnapshot,
  readSnapshotPageMeta,
  type PageSnapshot,
  type PublishedPageSeo,
} from './publish.js';
import { pagePublications, pages } from './schema.js';
import { getPageUrlPattern } from './settings.js';

export {
  DEFAULT_HOME_SLUG,
  matchPublicPagePath,
  toPublicPagePath,
} from './public-path.js';
export type {
  MatchPublicPagePathInput,
  PublicPagePathMatch,
  ToPublicPagePathInput,
} from './public-path.js';
export type { PublishedPageSeo };

/** What a visitor-path caller may see of a published page: nothing from the
 * working tree, no revision manifest, no author. */
export type PublishedPageView = {
  readonly page: {
    readonly id: string;
    readonly locale: string;
    readonly title: string;
    readonly resolvedPath: string;
    readonly seo: PublishedPageSeo;
  };
  readonly publication: {
    readonly id: string;
    readonly manifestHash: string;
    readonly publishedAt: Date;
    readonly snapshot: PageSnapshot;
  };
};

export type ResolvePublishedPageInput = {
  readonly locale: string;
  readonly resolvedPath: string;
};

/**
 * Reads the published page stored at `(locale, resolvedPath)`: ONE joined
 * select of `pages` to the publication its `live_publication_id` points at,
 * keyed on the existing partial unique index. It is one round trip and
 * atomic, unlike `readPublishedSnapshot`'s pointer-then-row pair, which can
 * join a pointer to a row an unpublish just removed.
 *
 * The visitor path reads the live `pages` row for `resolved_path` only (plus
 * the ids and the status/pointer it filters on) -- the fixed column list below
 * is what makes that acceptable (D-21's recorded accepted cost). The page's
 * `title` and SEO set come out of the published snapshot, frozen at publish
 * time, so renaming a page or editing its SEO changes nothing a visitor sees
 * until the next publish. A snapshot published before they were materialised
 * serves an empty title and the default SEO set (see `readSnapshotPageMeta`). Both `status = 'published'` and
 * `is_draft = false` are required, so a draft, scheduled, trashed or
 * unpublished page and a draft snapshot are invisible by construction.
 */
export async function resolvePublishedPage(
  db: AuditDatabase,
  input: ResolvePublishedPageInput,
): Promise<PublishedPageView | null> {
  const livePublication = eq(pagePublications.id, pages.livePublicationId);
  const [row] = await db
    .select({
      pageId: pages.id,
      locale: pages.locale,
      resolvedPath: pages.resolvedPath,
      publicationId: pagePublications.id,
      manifestHash: pagePublications.manifestHash,
      publishedAt: pagePublications.publishedAt,
      snapshot: pagePublications.snapshot,
    })
    .from(pages)
    .innerJoin(pagePublications, livePublication)
    .where(
      and(
        eq(pages.locale, input.locale),
        eq(pages.resolvedPath, input.resolvedPath),
        eq(pages.status, 'published'),
        eq(pagePublications.isDraft, false),
      ),
    )
    .limit(1);
  if (row === undefined) return null;

  const snapshot = asPageSnapshot(row.snapshot);
  const meta = readSnapshotPageMeta(snapshot);
  return {
    page: {
      id: row.pageId,
      locale: row.locale,
      title: meta.title,
      resolvedPath: row.resolvedPath ?? input.resolvedPath,
      seo: meta.seo,
    },
    publication: {
      id: row.publicationId,
      manifestHash: row.manifestHash,
      publishedAt: row.publishedAt,
      snapshot,
    },
  };
}

export type ResolveVisitorPageInput = MatchPublicPagePathInput;

export type VisitorPageResolution =
  | {
      readonly kind: 'page';
      readonly publicPath: string;
      readonly view: PublishedPageView;
    }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'not-found' }
  /** The stored pattern no longer parses (for example a pattern written
   * before literals were restricted). Nothing can be addressed, so a caller
   * answers a 404 and reports `error`; it is never thrown per request. */
  | {
      readonly kind: 'invalid-pattern';
      readonly error: PageUrlPatternError;
    };

/**
 * Resolves a public URL path for a visitor: the stored URL pattern (one
 * statement), the pure public-path mapping, then -- only for a match -- the
 * joined published read (a second statement). A redirect or an unshaped path
 * costs the pattern read alone. `page_blocks`, `block_revisions` and
 * `page_url_history` are never touched (D-24).
 *
 * A stored pattern is parsed strictly on write but may predate that rule. One
 * that does not parse resolves to `invalid-pattern` instead of throwing, so a
 * single bad setting cannot turn every request into an error: the visitor path
 * fails closed (nothing is addressable) and the caller reports it.
 */
export async function resolveVisitorPage(
  db: AuditDatabase,
  input: ResolveVisitorPageInput,
): Promise<VisitorPageResolution> {
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

  const view = await resolvePublishedPage(db, {
    locale: matched.locale,
    resolvedPath: matched.resolvedPath,
  });
  if (view === null) return { kind: 'not-found' };
  return { kind: 'page', publicPath: matched.publicPath, view };
}
