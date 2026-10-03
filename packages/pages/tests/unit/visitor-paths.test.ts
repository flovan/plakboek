/**
 * The pure mapping between a public URL path and a page's stored address
 * (D-22, D-23, D-26): the unprefixed default locale, the prefixed-spelling
 * redirect, the home slug and its redirect, literal-prefix patterns, the
 * single-locale pattern and the documented locale-prefix shadowing rule.
 */
import { describe, expect, it } from 'vitest';
import { checkPublicPageAddress } from '../../src/public-path.js';
import {
  DEFAULT_HOME_SLUG,
  matchPublicPagePath,
  toPublicPagePath,
  type MatchPublicPagePathInput,
  type PublicPagePathMatch,
} from '../../src/visitor.js';

const BASE: Omit<MatchPublicPagePathInput, 'publicPath'> = {
  locales: ['en', 'nl'],
  defaultLocale: 'en',
  homeSlug: DEFAULT_HOME_SLUG,
};

function match(pattern: string, publicPath: string): PublicPagePathMatch {
  return matchPublicPagePath(pattern, { ...BASE, publicPath });
}

type MatchRow = {
  readonly pattern: string;
  readonly publicPath: string;
  readonly locale: string;
  readonly path: string;
  readonly resolvedPath: string;
};

const MATCH_ROWS: readonly MatchRow[] = [
  {
    pattern: '{locale}/{path}',
    publicPath: '/about-us',
    locale: 'en',
    path: 'about-us',
    resolvedPath: 'en/about-us',
  },
  {
    pattern: '{locale}/{path}',
    publicPath: '/nl/over-ons',
    locale: 'nl',
    path: 'over-ons',
    resolvedPath: 'nl/over-ons',
  },
  {
    pattern: '{locale}/{path}',
    publicPath: '/nl/diensten/web',
    locale: 'nl',
    path: 'diensten/web',
    resolvedPath: 'nl/diensten/web',
  },
  {
    pattern: '{locale}/{path}',
    publicPath: '/',
    locale: 'en',
    path: 'home',
    resolvedPath: 'en/home',
  },
  {
    pattern: '{locale}/{path}',
    publicPath: '/nl',
    locale: 'nl',
    path: 'home',
    resolvedPath: 'nl/home',
  },
  {
    pattern: '{locale}/{path}',
    publicPath: '/diensten/web',
    locale: 'en',
    path: 'diensten/web',
    resolvedPath: 'en/diensten/web',
  },
  // An unknown first segment is just a default-locale path; the lookup misses.
  {
    pattern: '{locale}/{path}',
    publicPath: '/fr/x',
    locale: 'en',
    path: 'fr/x',
    resolvedPath: 'en/fr/x',
  },
  // The locale prefix wins over an English page whose slug is `nl`.
  {
    pattern: '{locale}/{path}',
    publicPath: '/nl/about',
    locale: 'nl',
    path: 'about',
    resolvedPath: 'nl/about',
  },
  {
    pattern: 'site/{locale}/{path}',
    publicPath: '/site/about-us',
    locale: 'en',
    path: 'about-us',
    resolvedPath: 'site/en/about-us',
  },
  {
    pattern: 'site/{locale}/{path}',
    publicPath: '/site/nl/over-ons',
    locale: 'nl',
    path: 'over-ons',
    resolvedPath: 'site/nl/over-ons',
  },
  {
    pattern: 'site/{locale}/{path}',
    publicPath: '/site',
    locale: 'en',
    path: 'home',
    resolvedPath: 'site/en/home',
  },
  {
    pattern: 'site/{locale}/{path}',
    publicPath: '/site/nl',
    locale: 'nl',
    path: 'home',
    resolvedPath: 'site/nl/home',
  },
  {
    pattern: '{path}',
    publicPath: '/about-us',
    locale: 'en',
    path: 'about-us',
    resolvedPath: 'about-us',
  },
  {
    pattern: '{path}',
    publicPath: '/',
    locale: 'en',
    path: 'home',
    resolvedPath: 'home',
  },
  {
    pattern: '{path}',
    publicPath: '/nl/over-ons',
    locale: 'en',
    path: 'nl/over-ons',
    resolvedPath: 'nl/over-ons',
  },
  {
    pattern: '{path}/{locale}',
    publicPath: '/over-ons/nl',
    locale: 'nl',
    path: 'over-ons',
    resolvedPath: 'over-ons/nl',
  },
  {
    pattern: '{path}/{locale}',
    publicPath: '/about-us',
    locale: 'en',
    path: 'about-us',
    resolvedPath: 'about-us/en',
  },
  {
    pattern: '{path}/{locale}',
    publicPath: '/nl',
    locale: 'nl',
    path: 'home',
    resolvedPath: 'home/nl',
  },
];

describe('matchPublicPagePath: matches', () => {
  it.each(MATCH_ROWS)(
    '$pattern: $publicPath -> $locale / $path',
    ({ pattern, publicPath, locale, path, resolvedPath }) => {
      expect(match(pattern, publicPath)).toEqual({
        kind: 'match',
        locale,
        path,
        resolvedPath,
        publicPath,
      });
    },
  );

  it('accepts an already-parsed pattern as well as a string', () => {
    expect(match('{locale}/{path}', '/nl/over-ons')).toEqual(
      matchPublicPagePath('{locale}/{path}', {
        ...BASE,
        publicPath: '/nl/over-ons',
      }),
    );
  });
});

type RedirectRow = {
  readonly pattern: string;
  readonly publicPath: string;
  readonly location: string;
};

const REDIRECT_ROWS: readonly RedirectRow[] = [
  {
    pattern: '{locale}/{path}',
    publicPath: '/en/about-us',
    location: '/about-us',
  },
  { pattern: '{locale}/{path}', publicPath: '/en', location: '/' },
  { pattern: '{locale}/{path}', publicPath: '/home', location: '/' },
  { pattern: '{locale}/{path}', publicPath: '/nl/home', location: '/nl' },
  { pattern: '{locale}/{path}', publicPath: '/en/home', location: '/' },
  {
    pattern: 'site/{locale}/{path}',
    publicPath: '/site/en/about-us',
    location: '/site/about-us',
  },
  {
    pattern: 'site/{locale}/{path}',
    publicPath: '/site/home',
    location: '/site',
  },
  { pattern: '{path}', publicPath: '/home', location: '/' },
  { pattern: '{path}/{locale}', publicPath: '/home/nl', location: '/nl' },
];

describe('matchPublicPagePath: redirects', () => {
  it.each(REDIRECT_ROWS)(
    '$pattern: $publicPath -> redirect $location',
    ({ pattern, publicPath, location }) => {
      expect(match(pattern, publicPath)).toEqual({
        kind: 'redirect',
        location,
      });
    },
  );
});

describe('matchPublicPagePath: rules', () => {
  it('never addresses a non-default locale under a pattern without {locale}', () => {
    const result = match('{path}', '/over-ons/nl');
    expect(result).toMatchObject({ kind: 'match', locale: 'en' });
    expect(match('{path}', '/en/about-us')).toMatchObject({
      kind: 'match',
      locale: 'en',
      path: 'en/about-us',
    });
  });

  it('only ever matches an enabled locale: a removed locale falls through to the default-locale path', () => {
    const result = matchPublicPagePath('{locale}/{path}', {
      publicPath: '/de/ueber-uns',
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      homeSlug: 'home',
    });
    expect(result).toMatchObject({
      kind: 'match',
      locale: 'en',
      path: 'de/ueber-uns',
    });
    const enabled = matchPublicPagePath('{locale}/{path}', {
      publicPath: '/de/ueber-uns',
      locales: ['en', 'nl', 'de'],
      defaultLocale: 'en',
      homeSlug: 'home',
    });
    expect(enabled).toMatchObject({ kind: 'match', locale: 'de' });
  });

  it('uses a configured home slug', () => {
    const result = matchPublicPagePath('{locale}/{path}', {
      ...BASE,
      homeSlug: 'start',
      publicPath: '/',
    });
    expect(result).toMatchObject({ kind: 'match', path: 'start' });
    expect(
      matchPublicPagePath('{locale}/{path}', {
        ...BASE,
        homeSlug: 'start',
        publicPath: '/start',
      }),
    ).toEqual({ kind: 'redirect', location: '/' });
    expect(
      matchPublicPagePath('{locale}/{path}', {
        ...BASE,
        homeSlug: 'start',
        publicPath: '/home',
      }),
    ).toMatchObject({ kind: 'match', path: 'home' });
  });

  it('returns none for a path that does not start with a slash, ends with one, holds an empty segment or a NUL', () => {
    expect(match('{locale}/{path}', 'about-us')).toEqual({ kind: 'none' });
    expect(match('{locale}/{path}', '')).toEqual({ kind: 'none' });
    expect(match('{locale}/{path}', '/about-us/')).toEqual({ kind: 'none' });
    expect(match('{locale}/{path}', '/a//b')).toEqual({ kind: 'none' });
    expect(match('{locale}/{path}', '/a\u0000b')).toEqual({ kind: 'none' });
  });
});

describe('toPublicPagePath', () => {
  // Every matched address inverts back to the spelling it was matched from.
  const rows = MATCH_ROWS;

  it.each(rows)(
    '$pattern: $locale / $path -> $publicPath',
    ({ pattern, locale, path, publicPath }) => {
      expect(
        toPublicPagePath(pattern, {
          locale,
          path,
          defaultLocale: 'en',
          homeSlug: 'home',
        }),
      ).toBe(publicPath);
    },
  );

  it('maps the Dutch home to /nl', () => {
    expect(
      toPublicPagePath('{locale}/{path}', {
        locale: 'nl',
        path: 'home',
        defaultLocale: 'en',
        homeSlug: 'home',
      }),
    ).toBe('/nl');
  });
});

describe('checkPublicPageAddress (a page whose public path leads elsewhere)', () => {
  const check = (
    pattern: string,
    locale: string,
    path: string,
    locales: readonly string[] = ['en', 'nl'],
  ) =>
    checkPublicPageAddress(pattern, {
      locale,
      path,
      locales,
      defaultLocale: 'en',
      homeSlug: DEFAULT_HOME_SLUG,
    });

  it('accepts ordinary addresses, the home slug and a non-default locale page named like a locale', () => {
    expect(check('{locale}/{path}', 'en', 'about-us')).toEqual({
      reachable: true,
      publicPath: '/about-us',
    });
    expect(check('{locale}/{path}', 'en', 'home').reachable).toBe(true);
    expect(check('{locale}/{path}', 'nl', 'over-ons').reachable).toBe(true);
    // The Dutch page `en` lives at `/nl/en`: the prefix wins, so it is fine.
    expect(check('{locale}/{path}', 'nl', 'en').reachable).toBe(true);
  });

  it('refuses a default-locale page whose path starts with the default locale code', () => {
    expect(check('{locale}/{path}', 'en', 'en/about')).toEqual({
      reachable: false,
      publicPath: '/en/about',
      outcome: 'redirect',
    });
  });

  it('refuses a default-locale page whose path starts with another enabled locale code', () => {
    expect(check('{locale}/{path}', 'en', 'nl/x')).toEqual({
      reachable: false,
      publicPath: '/nl/x',
      outcome: 'other-address',
    });
    expect(check('{locale}/{path}', 'en', 'nl').reachable).toBe(false);
  });

  it('only cares about locale codes that are enabled, and about patterns that carry the locale', () => {
    expect(check('{locale}/{path}', 'en', 'de/x').reachable).toBe(true);
    expect(check('{path}', 'en', 'nl/x').reachable).toBe(true);
  });
});
