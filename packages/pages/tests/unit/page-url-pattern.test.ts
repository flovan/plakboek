import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_URL_PATTERN,
  PAGE_URL_PATTERN_MAX_LENGTH,
  PAGE_URL_PATTERN_TOKENS,
  PageUrlPatternError,
  parsePageUrlPattern,
  resolvePageUrlPath,
  type PageUrlPatternIssue,
  type ParsedPageUrlPattern,
} from '../../src/page-url-pattern.js';

// This literal must equal the migration's own column default
// (`0003_page_block_engine`, `page_engine_settings.url_pattern`) exactly, so
// the two can never silently drift.
const MIGRATION_DEFAULT_URL_PATTERN = '{locale}/{path}';

describe('PAGE_URL_PATTERN_TOKENS / DEFAULT_PAGE_URL_PATTERN', () => {
  it('exposes exactly the locale and path tokens', () => {
    expect([...PAGE_URL_PATTERN_TOKENS].sort()).toEqual(['locale', 'path']);
  });

  it('matches the migration column default exactly (never drifts)', () => {
    expect(DEFAULT_PAGE_URL_PATTERN).toBe(MIGRATION_DEFAULT_URL_PATTERN);
  });
});

describe('parsePageUrlPattern', () => {
  it('parses "{locale}/{path}" into two token parts and one literal slash', () => {
    const parsed = parsePageUrlPattern('{locale}/{path}');
    expect(parsed.parts).toEqual([
      { kind: 'token', token: 'locale' },
      { kind: 'literal', value: '/' },
      { kind: 'token', token: 'path' },
    ]);
  });

  it('accepts "{path}" alone for a single-locale installation', () => {
    const parsed = parsePageUrlPattern('{path}');
    expect(parsed.parts).toEqual([{ kind: 'token', token: 'path' }]);
  });

  it('rejects "{locale}" alone with MISSING_PATH_TOKEN', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('{locale}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('MISSING_PATH_TOKEN');
  });

  it('rejects an unknown token, naming it and listing the accepted tokens', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('{slug}/{path}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('UNKNOWN_TOKEN');
    expect(issues[0]?.value).toBe('slug');
    expect(issues[0]?.message).toContain('locale');
    expect(issues[0]?.message).toContain('path');
  });

  it('rejects an unbalanced opening brace as UNBALANCED_BRACE, not a spanning unknown token', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('{locale/{path}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('UNBALANCED_BRACE');
  });

  it('rejects a pattern with a leading slash', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('/{locale}/{path}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues.map((issue) => issue.code)).toContain('LEADING_SLASH');
  });

  it('rejects a pattern with a trailing slash', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('{locale}/{path}/');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues.map((issue) => issue.code)).toContain('TRAILING_SLASH');
  });

  it('rejects a pattern with a double slash as EMPTY_SEGMENT', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('{locale}//{path}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues.map((issue) => issue.code)).toContain('EMPTY_SEGMENT');
  });

  it('rejects a pattern repeating a token as DUPLICATE_TOKEN', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('{path}/{path}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues.map((issue) => issue.code)).toContain('DUPLICATE_TOKEN');
  });

  it('rejects a pattern longer than PAGE_URL_PATTERN_MAX_LENGTH as PATTERN_TOO_LONG', () => {
    const overlong = `${'a'.repeat(PAGE_URL_PATTERN_MAX_LENGTH)}/{path}`;
    let error: unknown;
    try {
      parsePageUrlPattern(overlong);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues.map((issue) => issue.code)).toContain('PATTERN_TOO_LONG');
  });

  it('rejects an empty pattern as EMPTY_PATTERN', () => {
    let error: unknown;
    try {
      parsePageUrlPattern('');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    expect(issues.map((issue) => issue.code)).toContain('EMPTY_PATTERN');
  });

  it('collects every problem across one pattern with four planted problems, throwing once', () => {
    // Leading slash, trailing slash, an unknown token ("slug"), and a
    // duplicate "{path}" -- four independent, unrelated problems in one
    // pattern.
    const pattern = '/{slug}/{path}/{path}/';
    let error: unknown;
    try {
      parsePageUrlPattern(pattern);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PageUrlPatternError);
    const issues = (error as PageUrlPatternError).issues;
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('LEADING_SLASH');
    expect(codes).toContain('TRAILING_SLASH');
    expect(codes).toContain('UNKNOWN_TOKEN');
    expect(codes).toContain('DUPLICATE_TOKEN');
    expect(issues).toHaveLength(4);
  });
});

describe('parsePageUrlPattern literal alphabet', () => {
  function issuesOf(pattern: string): readonly PageUrlPatternIssue[] {
    try {
      parsePageUrlPattern(pattern);
    } catch (caught) {
      return caught instanceof PageUrlPatternError ? caught.issues : [];
    }
    return [];
  }

  it.each([
    '{locale}/{path}',
    '{path}',
    'site/{locale}/{path}',
    '{path}/{locale}',
    '{locale}/{path}/v2',
    'nl-be/{path}',
  ])('accepts %s', (pattern) => {
    expect(issuesOf(pattern)).toEqual([]);
  });

  it.each([
    ['Site/{path}', 'INVALID_LITERAL', 'Site/'],
    ['{path}.html', 'INVALID_LITERAL', '.html'],
    ['pages_v2/{path}', 'INVALID_LITERAL', 'pages_v2/'],
    ['{locale}/~{path}', 'INVALID_LITERAL', '/~'],
    ['a b/{path}', 'INVALID_LITERAL', 'a b/'],
    ['café/{path}', 'INVALID_LITERAL', 'café/'],
  ])(
    'rejects %s with %s for the offending literal',
    (pattern, code, literal) => {
      const issues = issuesOf(pattern);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe(code);
      expect(issues[0]?.value).toBe(literal);
    },
  );

  it('reports INVALID_LITERAL and TRAILING_SLASH together, never one at a time', () => {
    const codes = issuesOf('Site/{path}/').map((issue) => issue.code);
    expect(codes).toContain('INVALID_LITERAL');
    expect(codes).toContain('TRAILING_SLASH');
  });
});

describe('resolvePageUrlPath', () => {
  it('resolves "{locale}/{path}" to "nl/over-ons/team"', () => {
    expect(
      resolvePageUrlPath('{locale}/{path}', {
        locale: 'nl',
        path: 'over-ons/team',
      }),
    ).toBe('nl/over-ons/team');
  });

  it('resolves "{path}" to just the path, with no locale segment', () => {
    expect(
      resolvePageUrlPath('{path}', { locale: 'nl', path: 'over-ons/team' }),
    ).toBe('over-ons/team');
  });

  it('accepts an already-parsed pattern, not only a string', () => {
    const parsed = parsePageUrlPattern('{locale}/{path}');
    expect(resolvePageUrlPath(parsed, { locale: 'en', path: 'about' })).toBe(
      'en/about',
    );
  });

  it('never returns null: both tokens always resolve to a value', () => {
    const result = resolvePageUrlPath('{path}', { locale: 'en', path: 'x' });
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });
});

describe('discrimination check: MISSING_PATH_TOKEN must actually reject', () => {
  it('a pattern without {path} would make every page share one address if accepted -- the check must reject it', () => {
    // parsePageUrlPattern itself refuses "{locale}" alone (proven above).
    // To show *why* that refusal is load-bearing, bypass the guard with a
    // hand-built ParsedPageUrlPattern carrying only the {locale} token --
    // exactly the shape parsePageUrlPattern would have produced had the
    // MISSING_PATH_TOKEN check been removed -- and resolve two different
    // pages' addresses against it directly.
    expect(() => parsePageUrlPattern('{locale}')).toThrow(PageUrlPatternError);

    const noPathToken: ParsedPageUrlPattern = {
      source: '{locale}',
      parts: [{ kind: 'token', token: 'locale' }],
    };
    const pageOneAddress = resolvePageUrlPath(noPathToken, {
      locale: 'en',
      path: 'about',
    });
    const pageTwoAddress = resolvePageUrlPath(noPathToken, {
      locale: 'en',
      path: 'contact',
    });
    // If the missing-{path} check were removed, two entirely different
    // pages under the same locale would collide onto the identical
    // address -- proving the rejection above is load-bearing, not
    // decorative.
    expect(pageOneAddress).toBe(pageTwoAddress);
  });
});
