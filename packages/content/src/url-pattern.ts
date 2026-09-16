/**
 * URL pattern parsing and resolution (TYPE-06, D-30, D-31): a pattern is a
 * literal prefix plus any of `{slug}`, `{id}` and the six date tokens.
 * `parseUrlPattern` collects every problem in one pass and throws once,
 * mirroring `@plakboek/permissions`'s `RoleConfigError` shape -- a pattern
 * with three problems reports three issues, never just the first one found.
 *
 * Pattern literals are restricted to lowercase unreserved URL characters
 * (`[a-z0-9-._~]`, plus `/` as a path separator) so a resolved path never
 * needs escaping (T-03-17); `{slug}` is already normalised ASCII (see
 * `slug.ts`).
 *
 * `resolveUrlPath` resolves the date tokens from the entry's frozen
 * first-publish instant (D-30) in the given site timezone -- republishing
 * never moves it. No uniqueness is enforced when a pattern is saved (D-31);
 * collisions are refused at publish time by plan 03-07.
 */

export const URL_PATTERN_TOKENS = Object.freeze([
  'slug',
  'id',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
] as const);

export type UrlPatternToken = (typeof URL_PATTERN_TOKENS)[number];

const DATE_TOKENS = Object.freeze([
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
] as const);

type DateToken = (typeof DATE_TOKENS)[number];

export const URL_PATTERN_MAX_LENGTH = 500;

export type UrlPatternIssueCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'MISSING_LEADING_SLASH'
  | 'TRAILING_SLASH'
  | 'EMPTY_SEGMENT'
  | 'DOT_SEGMENT'
  | 'INVALID_CHARACTER'
  | 'UNKNOWN_TOKEN'
  | 'UNBALANCED_BRACE';

export type UrlPatternIssue = {
  readonly code: UrlPatternIssueCode;
  readonly index?: number;
  readonly value?: string;
  readonly message: string;
};

/** Thrown by `parseUrlPattern` with every problem found in the pattern,
 * collected before throwing once (never one-issue-at-a-time). */
export class UrlPatternError extends Error {
  readonly issues: readonly UrlPatternIssue[];

  constructor(issues: readonly UrlPatternIssue[]) {
    super(
      [
        '@plakboek/content: invalid URL pattern:',
        ...issues.map((issue) => issue.message),
      ].join('\n'),
    );
    this.name = 'UrlPatternError';
    this.issues = issues;
  }
}

type PatternPart =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'token'; readonly token: UrlPatternToken };

export type ParsedUrlPattern = {
  readonly pattern: string;
  readonly parts: readonly PatternPart[];
  readonly tokens: ReadonlySet<UrlPatternToken>;
};

const LITERAL_CHARACTER_PATTERN = /[a-z0-9._~-]/;

function isUrlPatternToken(value: string): value is UrlPatternToken {
  return URL_PATTERN_TOKENS.some((token) => token === value);
}

/**
 * Validates every path segment between slashes: an empty segment (a double
 * slash) is `EMPTY_SEGMENT`, and `.`/`..` are `DOT_SEGMENT` -- both true
 * regardless of what the segment's characters look like otherwise. Only
 * runs when the pattern has a leading slash; a missing leading slash is
 * already reported on its own and segment indices would be meaningless.
 */
function collectSegmentIssues(
  pattern: string,
  issues: UrlPatternIssue[],
): void {
  if (!pattern.startsWith('/')) return;

  const segments = pattern.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const isLastSegment = index === segments.length - 1;

    if (segment.length === 0) {
      // The true trailing-slash case (or the root pattern "/") is already
      // reported by the caller's own trailing-slash check -- an empty
      // segment only signals a genuine double slash when it isn't last.
      if (!isLastSegment) {
        issues.push({
          code: 'EMPTY_SEGMENT',
          index,
          message: `empty path segment at position ${index}`,
        });
      }
      continue;
    }

    if (segment === '.' || segment === '..') {
      issues.push({
        code: 'DOT_SEGMENT',
        value: segment,
        message: `"${segment}" is not a valid path segment`,
      });
    }
  }
}

/**
 * One left-to-right scan building `parts`/`tokens` while collecting
 * `INVALID_CHARACTER`, `UNKNOWN_TOKEN` and `UNBALANCED_BRACE` issues. A
 * `{` with no matching `}` stops the scan (nothing after it can be parsed
 * reliably) but every issue already found stays in `issues`.
 */
function scanPartsAndTokens(
  pattern: string,
  issues: UrlPatternIssue[],
): { parts: PatternPart[]; tokens: Set<UrlPatternToken> } {
  const parts: PatternPart[] = [];
  const tokens = new Set<UrlPatternToken>();
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
          index,
          message: `unbalanced "{" at index ${index}`,
        });
        break;
      }
      const tokenName = pattern.slice(index + 1, closeIndex);
      if (isUrlPatternToken(tokenName)) {
        flushLiteral();
        parts.push({ kind: 'token', token: tokenName });
        tokens.add(tokenName);
      } else {
        issues.push({
          code: 'UNKNOWN_TOKEN',
          index,
          value: tokenName,
          message: `unknown token "{${tokenName}}" at index ${index}`,
        });
      }
      index = closeIndex + 1;
      continue;
    }

    if (character === '}') {
      issues.push({
        code: 'UNBALANCED_BRACE',
        index,
        message: `unbalanced "}" at index ${index}`,
      });
      index += 1;
      continue;
    }

    if (character === '/') {
      flushLiteral();
      parts.push({ kind: 'literal', value: '/' });
      index += 1;
      continue;
    }

    if (character === undefined || !LITERAL_CHARACTER_PATTERN.test(character)) {
      issues.push({
        code: 'INVALID_CHARACTER',
        index,
        value: character,
        message: `invalid character "${character ?? ''}" at index ${index}`,
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
 * Parses a URL pattern (a literal prefix plus any of the eight tokens
 * above), collecting every problem before throwing once. The root pattern
 * `"/"` is valid.
 */
export function parseUrlPattern(pattern: string): ParsedUrlPattern {
  const issues: UrlPatternIssue[] = [];

  if (pattern.length === 0) {
    throw new UrlPatternError([
      { code: 'EMPTY', message: 'a URL pattern must not be empty' },
    ]);
  }

  if (pattern.length > URL_PATTERN_MAX_LENGTH) {
    issues.push({
      code: 'TOO_LONG',
      message: `a URL pattern must be at most ${URL_PATTERN_MAX_LENGTH} characters`,
    });
  }

  if (!pattern.startsWith('/')) {
    issues.push({
      code: 'MISSING_LEADING_SLASH',
      message: 'a URL pattern must start with "/"',
    });
  }

  if (pattern !== '/' && pattern.endsWith('/')) {
    issues.push({
      code: 'TRAILING_SLASH',
      message:
        'a URL pattern must not end with "/" (except the root pattern "/")',
    });
  }

  collectSegmentIssues(pattern, issues);
  const { parts, tokens } = scanPartsAndTokens(pattern, issues);

  if (issues.length > 0) {
    throw new UrlPatternError(issues);
  }

  return { pattern, parts, tokens };
}

/** True when `parsed` uses `{slug}`. */
export function usesSlugToken(parsed: ParsedUrlPattern): boolean {
  return parsed.tokens.has('slug');
}

/** True when `parsed` uses any of the six date tokens. */
export function usesDateTokens(parsed: ParsedUrlPattern): boolean {
  return DATE_TOKENS.some((token) => parsed.tokens.has(token));
}

function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new TypeError(`@plakboek/content: ${message}`);
  }
  return value;
}

/**
 * Formats `date` in `timezone` with exactly one `Intl.DateTimeFormat(...)
 * .formatToParts(date)` call, per D-30's zero-padded, 24-hour-clock
 * convention.
 */
function formatDateParts(
  date: Date,
  timezone: string,
): Record<DateToken, string> {
  const dateTimeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  function find(type: DateToken): string {
    const found = dateTimeParts.find((part) => part.type === type);
    return requireDefined(found, `formatToParts produced no "${type}" part`)
      .value;
  }

  return {
    year: find('year'),
    month: find('month'),
    day: find('day'),
    hour: find('hour'),
    minute: find('minute'),
    second: find('second'),
  };
}

export type UrlPathInput = {
  readonly slug: string | null;
  readonly publicId: number | string;
  readonly firstPublishedAt: Date | null;
};

function resolveTokenValue(
  token: UrlPatternToken,
  input: UrlPathInput,
  dateParts: Record<DateToken, string> | undefined,
): string {
  if (token === 'slug') {
    return requireDefined(input.slug, 'slug token resolved without a slug');
  }
  if (token === 'id') {
    return String(input.publicId);
  }
  const parts = requireDefined(
    dateParts,
    'date token resolved without dateParts',
  );
  return parts[token];
}

/**
 * Resolves `pattern` (a string, parsed first, or an already-parsed
 * `ParsedUrlPattern`) against one entry's `input` in `timezone`. Returns
 * `null` when `{slug}` is used and `input.slug` is `null`, or a date token
 * is used and `input.firstPublishedAt` is `null` -- otherwise substitutes
 * every token and returns the resolved path.
 */
export function resolveUrlPath(
  pattern: string | ParsedUrlPattern,
  input: UrlPathInput,
  timezone: string,
): string | null {
  const parsed =
    typeof pattern === 'string' ? parseUrlPattern(pattern) : pattern;

  if (usesSlugToken(parsed) && input.slug === null) {
    return null;
  }
  if (usesDateTokens(parsed) && input.firstPublishedAt === null) {
    return null;
  }

  const dateParts = usesDateTokens(parsed)
    ? formatDateParts(
        requireDefined(
          input.firstPublishedAt,
          'date token resolved without firstPublishedAt',
        ),
        timezone,
      )
    : undefined;

  let path = '';
  for (const part of parsed.parts) {
    path +=
      part.kind === 'literal'
        ? part.value
        : resolveTokenValue(part.token, input, dateParts);
  }
  return path;
}
