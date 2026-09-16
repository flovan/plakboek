import { describe, expect, it } from 'vitest';
import {
  URL_PATTERN_TOKENS,
  UrlPatternError,
  parseUrlPattern,
  resolveUrlPath,
} from '../../src/url-pattern.js';

describe('parseUrlPattern (TYPE-06, D-31)', () => {
  it('parses a prefix with multiple date/slug tokens', () => {
    const parsed = parseUrlPattern('/news/{year}/{month}/{slug}');
    expect([...parsed.tokens].sort()).toEqual(['month', 'slug', 'year']);
    expect(parsed.parts).toContainEqual({ kind: 'token', token: 'year' });
    expect(parsed.parts).toContainEqual({ kind: 'token', token: 'slug' });
  });

  it('parses a token beside a literal within one segment', () => {
    const parsed = parseUrlPattern('/news/{id}-{slug}');
    expect([...parsed.tokens].sort()).toEqual(['id', 'slug']);
    expect(parsed.parts).toContainEqual({ kind: 'literal', value: '-' });
  });

  it('parses the root pattern "/" with no tokens', () => {
    const parsed = parseUrlPattern('/');
    expect(parsed.tokens.size).toBe(0);
  });

  it('parses a pattern with no token, resolving to its literal path for any entry', () => {
    const parsed = parseUrlPattern('/about');
    expect(parsed.tokens.size).toBe(0);
    expect(
      resolveUrlPath(
        parsed,
        {
          slug: null,
          publicId: 1,
          firstPublishedAt: null,
        },
        'UTC',
      ),
    ).toBe('/about');
  });

  it.each([
    ['', 'empty pattern'],
    ['news/{slug}', 'missing leading slash'],
    ['/news/', 'trailing slash'],
    ['/news//{slug}', 'double slash (empty segment)'],
    ['/news/../{slug}', 'dot segment'],
    ['/News/{slug}', 'uppercase letter'],
    ['/news/{title}', 'unknown token'],
    ['/news/{slug', 'unbalanced brace'],
    ['/news/a b', 'character outside the allowed set'],
  ])('rejects %j (%s)', (pattern) => {
    expect(() => parseUrlPattern(pattern)).toThrow(UrlPatternError);
  });

  it('reports every issue in one pattern with three problems, not just the first', () => {
    let caught: UrlPatternError | undefined;
    try {
      parseUrlPattern('news/{title}/');
    } catch (error) {
      caught = error as UrlPatternError;
    }
    expect(caught).toBeInstanceOf(UrlPatternError);
    expect(caught?.issues.map((issue) => issue.code).sort()).toEqual(
      ['MISSING_LEADING_SLASH', 'TRAILING_SLASH', 'UNKNOWN_TOKEN'].sort(),
    );
  });

  it('exposes all eight tokens in URL_PATTERN_TOKENS', () => {
    expect([...URL_PATTERN_TOKENS].sort()).toEqual(
      ['day', 'hour', 'id', 'minute', 'month', 'second', 'slug', 'year'].sort(),
    );
  });
});

describe('resolveUrlPath (D-30)', () => {
  it('resolves slug, id and date tokens from the frozen first-publish instant in the site timezone', () => {
    expect(
      resolveUrlPath(
        '/news/{year}/{month}/{day}/{slug}',
        {
          slug: 'hi',
          publicId: 42,
          firstPublishedAt: new Date('2026-12-31T23:30:00.000Z'),
        },
        'Europe/Brussels',
      ),
    ).toBe('/news/2027/01/01/hi');
  });

  it('resolves {hour} across a DST spring-forward boundary', () => {
    expect(
      resolveUrlPath(
        '/news/{hour}',
        {
          slug: null,
          publicId: 1,
          firstPublishedAt: new Date('2026-03-29T01:30:00.000Z'),
        },
        'Europe/Brussels',
      ),
    ).toBe('/news/03');
  });

  it('zero-pads {hour}, {minute} and {second}', () => {
    expect(
      resolveUrlPath(
        '/e/{hour}/{minute}/{second}',
        {
          slug: null,
          publicId: 1,
          firstPublishedAt: new Date('2026-06-15T09:05:09.000Z'),
        },
        'UTC',
      ),
    ).toBe('/e/09/05/09');
  });

  it("resolves {id} to the entry's public id", () => {
    expect(
      resolveUrlPath(
        '/news/{id}',
        { slug: null, publicId: 42, firstPublishedAt: null },
        'UTC',
      ),
    ).toBe('/news/42');
  });

  it('returns null when {slug} is used and slug is null', () => {
    expect(
      resolveUrlPath(
        '/news/{slug}',
        { slug: null, publicId: 1, firstPublishedAt: new Date() },
        'UTC',
      ),
    ).toBeNull();
  });

  it('returns null when a date token is used and firstPublishedAt is null', () => {
    expect(
      resolveUrlPath(
        '/news/{year}/{slug}',
        { slug: 'hi', publicId: 1, firstPublishedAt: null },
        'UTC',
      ),
    ).toBeNull();
  });
});
