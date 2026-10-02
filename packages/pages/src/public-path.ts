/**
 * The pure public-path mapping of the visitor read side (D-22..D-26): which
 * public URL path denotes which stored `(locale, path)` page address under the
 * project-wide URL pattern, and back. No I/O. `visitor.ts` re-exports this
 * and `publish.ts` uses it to refuse an address that could never be reached,
 * which is why it sits in its own module (visitor.ts imports publish.ts).
 *
 * The default locale is served without a locale prefix, so a default-locale
 * page whose hierarchy path starts with an enabled locale code (or a locale
 * root spelled like one) shares its public spelling with another address and
 * loses to it: see `toPublicPagePath`.
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
 * The public path a stored `(locale, path)` address is written as. The home
 * slug maps to the locale root.
 *
 * This is the inverse of `matchPublicPagePath` only for an address that is
 * reachable: `matchPublicPagePath(toPublicPagePath(a))` returns `a` unless the
 * default locale's unprefixed spelling collides with another candidate -- a
 * default-locale page whose path starts with an enabled locale code (`nl/x`
 * is also the Dutch page `x`; `en/about` is the prefixed default and
 * redirects to `/about`). `checkPublicPageAddress` detects exactly those.
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

export type CheckPublicPageAddressInput = {
  readonly locale: string;
  readonly path: string;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly homeSlug: string;
};

/** What a page's own public path actually resolves to when it is not the page. */
export type PublicPageAddressCheck =
  | { readonly reachable: true; readonly publicPath: string }
  | {
      readonly reachable: false;
      readonly publicPath: string;
      /** `redirect`: the path 308s elsewhere; `other-address`: it resolves to
       * a different `(locale, path)`; `none`: it matches nothing. */
      readonly outcome: 'redirect' | 'other-address' | 'none';
    };

/**
 * Whether a page stored at `(locale, path)` can be reached at the public path
 * it is written as: the round trip `toPublicPagePath` then
 * `matchPublicPagePath` must land on the same address. Pure; the caller
 * decides what to do with an address that fails.
 */
export function checkPublicPageAddress(
  pattern: string | ParsedPageUrlPattern,
  input: CheckPublicPageAddressInput,
): PublicPageAddressCheck {
  const publicPath = toPublicPagePath(pattern, {
    locale: input.locale,
    path: input.path,
    defaultLocale: input.defaultLocale,
    homeSlug: input.homeSlug,
  });
  const matched = matchPublicPagePath(pattern, {
    publicPath,
    locales: input.locales,
    defaultLocale: input.defaultLocale,
    homeSlug: input.homeSlug,
  });
  if (
    matched.kind === 'match' &&
    matched.locale === input.locale &&
    matched.path === input.path
  ) {
    return { reachable: true, publicPath };
  }
  return {
    reachable: false,
    publicPath,
    outcome:
      matched.kind === 'redirect'
        ? 'redirect'
        : matched.kind === 'match'
          ? 'other-address'
          : 'none',
  };
}
