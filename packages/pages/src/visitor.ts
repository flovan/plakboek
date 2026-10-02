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
 *   equals an enabled locale code: an English page with slug `nl` is
 *   unreachable at `/nl/...`. A write-time guard is a later phase's.
 * - Under a pattern without `{locale}` only the default locale is
 *   addressable (the single-locale case the pattern parser documents).
 * - Only the enabled locales passed in are candidates, so a removed locale
 *   (rows kept, 03 D-25 / 04 D-37) can never match.
 * - Only pages resolve; content-entry URLs are not matched here (D-25).
 * - The previous-address history is never consulted: redirects over it are a
 *   later phase's (D-24).
 */
import {
  parsePageUrlPattern,
  resolvePageUrlPath,
  type ParsedPageUrlPattern,
} from './page-url-pattern.js';

/** The hierarchy path of the page served at a locale's root (D-26). */
export const DEFAULT_HOME_SLUG = 'home';

export type MatchPublicPagePathInput = {
  readonly publicPath: string;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly homeSlug: string;
};

export type ToPublicPagePathInput = {
  readonly locale: string;
  readonly path: string;
  readonly defaultLocale: string;
  readonly homeSlug: string;
};

export type PublicPagePathMatch =
  | {
      readonly kind: 'match';
      readonly locale: string;
      readonly path: string;
      readonly resolvedPath: string;
      readonly publicPath: string;
    }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'none' };

/** Cannot occur in a URL path, so splitting on it never confuses a literal. */
const SENTINEL = '\u0000';

function asParsed(
  pattern: string | ParsedPageUrlPattern,
): ParsedPageUrlPattern {
  return typeof pattern === 'string' ? parsePageUrlPattern(pattern) : pattern;
}

function hasLocaleToken(parsed: ParsedPageUrlPattern): boolean {
  return parsed.parts.some(
    (part) => part.kind === 'token' && part.token === 'locale',
  );
}

/**
 * The one place a public spelling is composed: the stored pattern resolved
 * for `locale` (an empty locale value for the default one, so its segment
 * disappears), runs of `/` collapsed, outer slashes stripped, then a single
 * leading `/` put back. An empty `path` is the locale root.
 */
function publicForm(
  parsed: ParsedPageUrlPattern,
  localeValue: string,
  path: string,
): string {
  const raw = resolvePageUrlPath(parsed, { locale: localeValue, path });
  const collapsed = raw.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return `/${collapsed}`;
}

/**
 * The public path of a stored `(locale, path)` address -- the inverse of
 * `matchPublicPagePath` for every address it can match. The home slug maps
 * to the locale root.
 */
export function toPublicPagePath(
  pattern: string | ParsedPageUrlPattern,
  input: ToPublicPagePathInput,
): string {
  const parsed = asParsed(pattern);
  const localeValue = input.locale === input.defaultLocale ? '' : input.locale;
  return publicForm(
    parsed,
    localeValue,
    input.path === input.homeSlug ? '' : input.path,
  );
}

type Candidate = {
  /** The locale the match would belong to. */
  readonly locale: string;
  /** What `{locale}` expands to in the spelling this candidate recognises. */
  readonly localeValue: string;
  /** True only for the default locale written with its code. */
  readonly prefixedDefault: boolean;
};

type Shape = {
  readonly prefix: string;
  readonly suffix: string;
  readonly home: string;
};

function shapeOf(parsed: ParsedPageUrlPattern, localeValue: string): Shape {
  const probe = publicForm(parsed, localeValue, SENTINEL);
  const at = probe.indexOf(SENTINEL);
  return {
    prefix: probe.slice(0, at),
    suffix: probe.slice(at + SENTINEL.length),
    home: publicForm(parsed, localeValue, ''),
  };
}

/** The hierarchy path between a candidate's prefix and suffix, or `null`. */
function middleOf(publicPath: string, shape: Shape): string | null {
  if (publicPath.length < shape.prefix.length + shape.suffix.length) {
    return null;
  }
  if (!publicPath.startsWith(shape.prefix)) return null;
  if (!publicPath.endsWith(shape.suffix)) return null;
  const middle = publicPath.slice(
    shape.prefix.length,
    publicPath.length - shape.suffix.length,
  );
  if (middle.length === 0) return null;
  if (middle.startsWith('/') || middle.endsWith('/')) return null;
  return middle;
}

/**
 * Maps a public URL path to the page address it denotes under the stored
 * project-wide `pattern`: a `match` carrying the stored `(locale, path)` and
 * the `resolvedPath` Phase 4 materialises, a `redirect` to the canonical
 * spelling, or `none` for a path that is not even shaped like one.
 *
 * Candidates are tried in a fixed order and the first hit wins: (1) each
 * enabled non-default locale in `locales` order; (2) only when the pattern
 * contains `{locale}`, the default locale written with its code -- any hit is
 * a redirect to the bare spelling; (3) the default locale's bare spelling.
 * The order is what makes the locale prefix win over a same-named
 * default-locale slug.
 */
export function matchPublicPagePath(
  pattern: string | ParsedPageUrlPattern,
  input: MatchPublicPagePathInput,
): PublicPagePathMatch {
  const { publicPath, defaultLocale, homeSlug } = input;
  if (
    !publicPath.startsWith('/') ||
    publicPath.includes(SENTINEL) ||
    publicPath.includes('//') ||
    (publicPath.length > 1 && publicPath.endsWith('/'))
  ) {
    return { kind: 'none' };
  }

  const parsed = asParsed(pattern);
  const localized = hasLocaleToken(parsed);

  const candidates: Candidate[] = [];
  if (localized) {
    for (const locale of input.locales) {
      if (locale === defaultLocale) continue;
      candidates.push({
        locale,
        localeValue: locale,
        prefixedDefault: false,
      });
    }
    candidates.push({
      locale: defaultLocale,
      localeValue: defaultLocale,
      prefixedDefault: true,
    });
  }
  candidates.push({
    locale: defaultLocale,
    localeValue: '',
    prefixedDefault: false,
  });

  for (const candidate of candidates) {
    const shape = shapeOf(parsed, candidate.localeValue);
    const canonicalRoot = toPublicPagePath(parsed, {
      locale: candidate.locale,
      path: homeSlug,
      defaultLocale,
      homeSlug,
    });

    if (publicPath === shape.home) {
      if (candidate.prefixedDefault) {
        return { kind: 'redirect', location: canonicalRoot };
      }
      return {
        kind: 'match',
        locale: candidate.locale,
        path: homeSlug,
        resolvedPath: resolvePageUrlPath(parsed, {
          locale: candidate.locale,
          path: homeSlug,
        }),
        publicPath: canonicalRoot,
      };
    }

    const middle = middleOf(publicPath, shape);
    if (middle === null) continue;

    if (middle === homeSlug) {
      return { kind: 'redirect', location: canonicalRoot };
    }
    const canonical = toPublicPagePath(parsed, {
      locale: candidate.locale,
      path: middle,
      defaultLocale,
      homeSlug,
    });
    if (candidate.prefixedDefault) {
      return { kind: 'redirect', location: canonical };
    }
    return {
      kind: 'match',
      locale: candidate.locale,
      path: middle,
      resolvedPath: resolvePageUrlPath(parsed, {
        locale: candidate.locale,
        path: middle,
      }),
      publicPath: canonical,
    };
  }

  return { kind: 'none' };
}
