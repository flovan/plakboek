/**
 * Pages URL pattern parsing and resolution (D-22): one project-wide pattern
 * composing with the hierarchical page path, `{locale}/{path}` by default.
 *
 * This is a separate parser from `@plakboek/content`'s `url-pattern.ts`, not
 * a wrapper around it: that module's `URL_PATTERN_TOKENS` are `slug | id |
 * year | month | day | hour | minute | second` -- it has no `{locale}` and
 * no `{path}` token, so a pages pattern like `{locale}/{path}` is an unknown
 * token to it. Widening a shipped, entry-shaped contract to carry page-only
 * tokens would couple two independent address models that this project
 * deliberately keeps apart (pages compose one hierarchical path per
 * install; entries resolve per content type, per entry). This module
 * mirrors that one's shape -- the same collect-then-throw issue list, the
 * same parsed-parts representation, the same length-bound convention -- but
 * owns its own token vocabulary end to end.
 *
 * Unlike the entry parser, a page pattern carries no leading slash (the
 * hierarchy's own `path` already forbids one, `pages_path_check`) and never
 * resolves to `null`: `{locale}` and `{path}` always have a value once a
 * page is published, so `resolvePageUrlPath` always returns a string.
 */

export const PAGE_URL_PATTERN_TOKENS = Object.freeze([
  'locale',
  'path',
] as const);

export type PageUrlPatternToken = (typeof PAGE_URL_PATTERN_TOKENS)[number];

/** The migration's `page_engine_settings.url_pattern` column default
 * (`0003_page_block_engine`) -- kept in lockstep by this module's own unit
 * test, so the two can never drift. */
export const DEFAULT_PAGE_URL_PATTERN = '{locale}/{path}';

export const PAGE_URL_PATTERN_MAX_LENGTH = 200;

export type PageUrlPatternIssueCode =
  | 'UNKNOWN_TOKEN'
  | 'UNBALANCED_BRACE'
  | 'MISSING_PATH_TOKEN'
  | 'DUPLICATE_TOKEN'
  | 'LEADING_SLASH'
  | 'TRAILING_SLASH'
  | 'EMPTY_SEGMENT'
  | 'PATTERN_TOO_LONG'
  | 'EMPTY_PATTERN';

export type PageUrlPatternIssue = {
  readonly code: PageUrlPatternIssueCode;
  readonly value?: string;
  readonly message: string;
};

/** Thrown by `parsePageUrlPattern` with every problem found in the pattern,
 * collected before throwing once (never one-issue-at-a-time). */
export class PageUrlPatternError extends Error {
  readonly issues: readonly PageUrlPatternIssue[];

  constructor(issues: readonly PageUrlPatternIssue[]) {
    super(
      [
        '[@plakboek/pages] invalid page URL pattern:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'PageUrlPatternError';
    this.issues = issues;
  }
}

type PatternPart =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'token'; readonly token: PageUrlPatternToken };

export type ParsedPageUrlPattern = {
  readonly source: string;
  readonly parts: readonly PatternPart[];
};

function isPageUrlPatternToken(value: string): value is PageUrlPatternToken {
  return PAGE_URL_PATTERN_TOKENS.some((token) => token === value);
}

/**
 * Flags a genuine double slash (an empty segment strictly between two
 * others) as `EMPTY_SEGMENT`. The first and last segments are skipped here:
 * a leading or trailing slash is already its own, more specific issue
 * (`LEADING_SLASH`/`TRAILING_SLASH`), so an empty first/last segment would
 * otherwise be reported twice for the same character.
 */
function collectSegmentIssues(
  pattern: string,
  issues: PageUrlPatternIssue[],
): void {
  const segments = pattern.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    if (segment.length === 0 && !isFirst && !isLast) {
      issues.push({
        code: 'EMPTY_SEGMENT',
        message: `empty path segment at position ${index}`,
      });
    }
  }
}

/**
 * One left-to-right scan building `parts` while collecting `UNKNOWN_TOKEN`,
 * `DUPLICATE_TOKEN` and `UNBALANCED_BRACE` issues. A `{` is unbalanced not
 * only when no `}` follows it anywhere in the pattern, but also when
 * another `{` appears before the first `}` does -- `{locale/{path}` has a
 * real closing brace, but not one that belongs to the first `{`, so it is
 * `UNBALANCED_BRACE`, not an unknown token spanning both. In that case the
 * unmatched `{` is dropped (one character consumed) and scanning resumes
 * from the character right after it, so the second `{` still gets a fair
 * chance to parse as its own token.
 */
function scanPageUrlPatternParts(
  pattern: string,
  issues: PageUrlPatternIssue[],
): { parts: PatternPart[]; tokens: Set<PageUrlPatternToken> } {
  const parts: PatternPart[] = [];
  const tokens = new Set<PageUrlPatternToken>();
  let literalBuffer = '';

  function flushLiteral(): void {
    if (literalBuffer.length > 0) {
      parts.push({ kind: 'literal', value: literalBuffer });
      literalBuffer = '';
    }
  }

  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];

    if (character === '{') {
      const closeIndex = pattern.indexOf('}', index + 1);
      if (closeIndex === -1) {
        issues.push({
          code: 'UNBALANCED_BRACE',
          message: `unbalanced "{" at index ${index}`,
        });
        break;
      }
      const openIndex = pattern.indexOf('{', index + 1);
      if (openIndex !== -1 && openIndex < closeIndex) {
        issues.push({
          code: 'UNBALANCED_BRACE',
          message: `unbalanced "{" at index ${index}`,
        });
        index += 1;
        continue;
      }
      const tokenName = pattern.slice(index + 1, closeIndex);
      if (isPageUrlPatternToken(tokenName)) {
        flushLiteral();
        parts.push({ kind: 'token', token: tokenName });
        if (tokens.has(tokenName)) {
          issues.push({
            code: 'DUPLICATE_TOKEN',
            value: tokenName,
            message: `token "{${tokenName}}" is used more than once`,
          });
        }
        tokens.add(tokenName);
      } else {
        issues.push({
          code: 'UNKNOWN_TOKEN',
          value: tokenName,
          message: `unknown token "{${tokenName}}" at index ${index} (accepted tokens: ${PAGE_URL_PATTERN_TOKENS.join(', ')})`,
        });
      }
      index = closeIndex + 1;
      continue;
    }

    if (character === '}') {
      issues.push({
        code: 'UNBALANCED_BRACE',
        message: `unbalanced "}" at index ${index}`,
      });
      index += 1;
      continue;
    }

    literalBuffer += character;
    index += 1;
  }
  flushLiteral();

  return { parts, tokens };
}

/**
 * Parses a page URL pattern -- a literal prefix/infix plus `{locale}`
 * and/or `{path}` -- collecting every problem before throwing once
 * (`PageUrlPatternError`). Unlike `@plakboek/content`'s entry pattern, a
 * page pattern never starts or ends with `/` and must always include
 * `{path}` (D-22: without it every page would share the same address).
 * `{path}` alone is valid for a single-locale installation that doesn't
 * need the locale segment.
 */
export function parsePageUrlPattern(pattern: string): ParsedPageUrlPattern {
  const issues: PageUrlPatternIssue[] = [];

  if (pattern.length === 0) {
    issues.push({
      code: 'EMPTY_PATTERN',
      message: 'a page URL pattern must not be empty',
    });
  } else {
    if (pattern.length > PAGE_URL_PATTERN_MAX_LENGTH) {
      issues.push({
        code: 'PATTERN_TOO_LONG',
        message: `a page URL pattern must be at most ${PAGE_URL_PATTERN_MAX_LENGTH} characters`,
      });
    }
    if (pattern.startsWith('/')) {
      issues.push({
        code: 'LEADING_SLASH',
        message: 'a page URL pattern must not start with "/"',
      });
    }
    if (pattern.endsWith('/')) {
      issues.push({
        code: 'TRAILING_SLASH',
        message: 'a page URL pattern must not end with "/"',
      });
    }
    collectSegmentIssues(pattern, issues);
  }

  const { parts, tokens } = scanPageUrlPatternParts(pattern, issues);

  if (!tokens.has('path')) {
    issues.push({
      code: 'MISSING_PATH_TOKEN',
      message:
        'a page URL pattern must include the "{path}" token, or every page would share the same address',
    });
  }

  if (issues.length > 0) {
    throw new PageUrlPatternError(issues);
  }

  return { source: pattern, parts };
}

export type ResolvePageUrlPathInput = {
  readonly locale: string;
  readonly path: string;
};

/**
 * Resolves `pattern` (a string, parsed first, or an already-parsed
 * `ParsedPageUrlPattern`) against one page's `locale` and hierarchical
 * `path`, substituting every token and concatenating the literals. Unlike
 * `@plakboek/content`'s `resolveUrlPath`, this never returns `null`: both
 * `{locale}` and `{path}` always have a value for a page (the entry
 * parser's optional `{slug}`/date tokens have no equivalent here).
 */
export function resolvePageUrlPath(
  pattern: string | ParsedPageUrlPattern,
  input: ResolvePageUrlPathInput,
): string {
  const parsed =
    typeof pattern === 'string' ? parsePageUrlPattern(pattern) : pattern;

  let path = '';
  for (const part of parsed.parts) {
    path += part.kind === 'literal' ? part.value : input[part.token];
  }
  return path;
}
