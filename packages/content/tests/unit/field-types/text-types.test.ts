import { describe, expect, it } from 'vitest';
import { isSafePattern } from '../../../src/field-types/pattern-safety.js';
import {
  FieldDefinitionError,
  getFieldTypeDefinition,
  parseFieldOptions,
  type FieldType,
} from '../../../src/field-types/registry.js';

type FailedParseIssue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

type ParseOutcome =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly FailedParseIssue[] };
    };

/** Narrows a `safeParse` result to its failure branch without a
 * conditional `expect(...)` call (oxlint's vitest/no-conditional-expect). */
function failureIssues(result: ParseOutcome): readonly FailedParseIssue[] {
  if (result.success) {
    throw new Error('expected zod safeParse to fail');
  }
  return result.error.issues;
}

function buildValueSchema(fieldType: FieldType, options: unknown) {
  const definition = getFieldTypeDefinition(fieldType);
  const parsedOptions = parseFieldOptions(fieldType, options);
  return definition.buildValueSchema(parsedOptions);
}

/** Ambiguous alternation under a repeat, plus the flag-propagation variants
 * (`((a+))*b`, `((a|a)x)*b`, `((a|a))*b`) that reach the same catastrophic
 * class one level deeper than the group the quantifier directly follows. */
const REDOS_CORPUS = [
  '(a|a)*',
  '(a|aa)+',
  '(a|a)*b',
  '(a|aa)+b',
  '(?:a|a)*b',
  '(a|b|ab)*c',
  '(a|a){30}b',
  '(a|a){2,}b',
  '((a|a)x)*b',
  '((a|a))*b',
  '((a+))*b',
  // D-CR-01: a bounded-but-variable-width inner quantifier (min !== max)
  // repeated by an outer quantifier that can apply more than once is the
  // same catastrophic shape as `(a+)+`, even though no inner quantifier is
  // literally unbounded.
  '(a{1,2})+',
  '(a{2,5})*',
] as const;

/** Alternation shapes a customer would plausibly author in a `short_text`
 * validation pattern: none of them repeats the alternating group. */
const SAFE_PATTERN_CORPUS = [
  '^[A-Z]{2}-\\d{4}$',
  '^(cat|dog|bird)$',
  '^(Mr|Ms|Mx)?\\s?[A-Za-z ]+$',
  '^https?://[a-z0-9.-]+$',
  '^(\\+32|0)\\d{8,9}$',
  '^(19|20)\\d{2}-\\d{2}-\\d{2}$',
  '^(EUR|USD|GBP) \\d+([.,]\\d{2})?$',
  '^#[0-9a-fA-F]{6}$',
  '^\\d{4} ?[A-Z]{2}$',
  // D-WR-01: an optional group can apply at most once, so a `+`/`*` inside
  // it creates no ambiguity across repeats of the outer group -- the outer
  // `?` is the same "cannot repeat more than once" shape the alternation
  // rule already exempts.
  '(v\\d+\\.)?\\d+\\.\\d+',
] as const;

const REDOS_PROBE_LENGTH = 28;
const REDOS_TIME_BUDGET_MS = 150;

describe('isSafePattern', () => {
  it('accepts a bounded pattern', () => {
    expect(isSafePattern('^[A-Z]{2}-\\d{4}$')).toBe(true);
  });

  it('rejects a nested unbounded quantifier on a quantified group', () => {
    expect(isSafePattern('(a+)+')).toBe(false);
    expect(isSafePattern('(\\w*)*x')).toBe(false);
  });

  it('rejects a backreference', () => {
    expect(isSafePattern('(a)\\1')).toBe(false);
  });

  it('rejects a pattern that fails to compile', () => {
    expect(isSafePattern('[')).toBe(false);
  });

  it('rejects a pattern longer than 200 characters', () => {
    expect(isSafePattern('a'.repeat(201))).toBe(false);
  });

  it('rejects every shape in the ambiguous-alternation rejection corpus, including the flag-propagation variants', () => {
    const accepted = REDOS_CORPUS.filter((pattern) => isSafePattern(pattern));
    expect(accepted).toEqual([]);
  });

  it('accepts every plausible customer pattern in the safe-pattern corpus', () => {
    const rejected = SAFE_PATTERN_CORPUS.filter(
      (pattern) => !isSafePattern(pattern),
    );
    expect(rejected).toEqual([]);
  });

  it('keeps a literal bar accepted: inside a character class, escaped, and top-level outside every group', () => {
    expect(isSafePattern('[a|b]+')).toBe(true);
    expect(isSafePattern('\\|+')).toBe(true);
    expect(isSafePattern('a|a')).toBe(true);
  });

  it('keeps a repeat that cannot repeat the group more than once accepted', () => {
    expect(isSafePattern('(a|a)?b')).toBe(true);
    expect(isSafePattern('(a|a){0,1}b')).toBe(true);
    expect(isSafePattern('(a|a){1}b')).toBe(true);
  });

  it('every pattern the guard accepts matches an adversarial input in bounded time', () => {
    const candidates = [
      ...REDOS_CORPUS,
      ...SAFE_PATTERN_CORPUS,
      '[a|b]+',
      '\\|+',
      'a|a',
      '(a|a)?b',
      '(a|a){0,1}b',
      '(a|a){1}b',
    ];
    const probe = 'a'.repeat(REDOS_PROBE_LENGTH);
    const offenders = candidates
      .filter((pattern) => isSafePattern(pattern))
      .map((pattern) => {
        const wholeValuePattern = new RegExp(`^(?:${pattern})$`, 'u');
        const start = performance.now();
        wholeValuePattern.test(probe);
        return { pattern, elapsedMs: performance.now() - start };
      })
      .filter((result) => result.elapsedMs > REDOS_TIME_BUDGET_MS);

    expect(offenders).toEqual([]);
  });
});

describe('short_text', () => {
  it('accepts a value matching a safe whole-value pattern and rejects a partial match', () => {
    const schema = buildValueSchema('short_text', {
      pattern: '[A-Z]{2}\\d{2}',
    });
    expect(schema.safeParse('AB12').success).toBe(true);
    expect(schema.safeParse('xAB12').success).toBe(false);
  });

  it('throws FieldDefinitionError when defined with an unsafe pattern', () => {
    expect(() => parseFieldOptions('short_text', { pattern: '(a+)+' })).toThrow(
      FieldDefinitionError,
    );
  });

  it('throws FieldDefinitionError for ambiguous alternation under a repeat, including through flag propagation', () => {
    expect(() =>
      parseFieldOptions('short_text', { pattern: '(a|a)*' }),
    ).toThrow(FieldDefinitionError);
    expect(() =>
      parseFieldOptions('short_text', { pattern: '((a+))*b' }),
    ).toThrow(FieldDefinitionError);
  });

  it('still accepts a disjoint alternation pattern end to end', () => {
    const schema = buildValueSchema('short_text', { pattern: '^(cat|dog)$' });
    expect(schema.safeParse('cat').success).toBe(true);
    expect(schema.safeParse('fox').success).toBe(false);
  });

  it('counts maxLength/minLength in Unicode code points', () => {
    const maxSchema = buildValueSchema('short_text', { maxLength: 3 });
    expect(maxSchema.safeParse('\u{1F600}\u{1F600}\u{1F600}').success).toBe(
      true,
    );
    expect(
      maxSchema.safeParse('\u{1F600}\u{1F600}\u{1F600}\u{1F600}').success,
    ).toBe(false);

    const minSchema = buildValueSchema('short_text', { minLength: 2 });
    expect(minSchema.safeParse('a').success).toBe(false);
    expect(minSchema.safeParse('ab').success).toBe(true);
  });
});

describe('long_text', () => {
  it('accepts newlines and rejects a value over maxLength', () => {
    const schema = buildValueSchema('long_text', { maxLength: 5 });
    expect(schema.safeParse('a\nb\nc').success).toBe(true);
    expect(schema.safeParse('abcdef').success).toBe(false);
  });

  it('has no pattern option', () => {
    expect(() =>
      parseFieldOptions('long_text', { maxLength: 5, pattern: 'x' }),
    ).toThrow(FieldDefinitionError);
  });
});

describe('rich_text', () => {
  it('accepts a well-formed doc, rejects an HTML string, and treats an empty doc as empty', () => {
    const definition = getFieldTypeDefinition('rich_text');
    const options = parseFieldOptions('rich_text', {});
    const schema = definition.buildValueSchema(options);

    expect(
      schema.safeParse({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hi' }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(schema.safeParse('<p>Hi</p>').success).toBe(false);
    expect(definition.isEmptyValue({ type: 'doc' })).toBe(true);
    expect(definition.isEmptyValue({ type: 'doc', content: [] })).toBe(true);
  });

  it('rejects a node nested deeper than the maximum depth', () => {
    const definition = getFieldTypeDefinition('rich_text');
    const options = parseFieldOptions('rich_text', {});
    const schema = definition.buildValueSchema(options);

    let deepNode: Record<string, unknown> = { type: 'text', text: 'leaf' };
    for (let level = 0; level < 40; level += 1) {
      deepNode = { type: 'paragraph', content: [deepNode] };
    }
    const doc = { type: 'doc', content: [deepNode] };
    expect(schema.safeParse(doc).success).toBe(false);
  });
});

describe('slug (field type)', () => {
  it('accepts lowercase hyphenated slug text and rejects everything else', () => {
    const schema = buildValueSchema('slug', {});
    expect(schema.safeParse('section-2').success).toBe(true);
    expect(schema.safeParse('Section 2').success).toBe(false);
    expect(schema.safeParse('-a').success).toBe(false);
    expect(schema.safeParse('a--b').success).toBe(false);
  });
});

describe('url', () => {
  it('accepts an absolute https URL and rejects other schemes', () => {
    const schema = buildValueSchema('url', {});
    expect(schema.safeParse('https://example.com/a').success).toBe(true);
    expect(schema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(schema.safeParse('ftp://x').success).toBe(false);
  });

  it('with allowRelative accepts a single-slash path and rejects a protocol-relative one', () => {
    const schema = buildValueSchema('url', { allowRelative: true });
    expect(schema.safeParse('/about').success).toBe(true);
    expect(schema.safeParse('//evil.example').success).toBe(false);
  });

  it('with allowRelative rejects a leading-backslash value the WHATWG URL parser would resolve as protocol-relative (D-CR-04)', () => {
    const schema = buildValueSchema('url', { allowRelative: true });
    // The WHATWG URL parser normalises a backslash to a forward slash in a
    // special-scheme URL, so `/\evil.com` resolves to `https://evil.com/`
    // against any base origin. Confirm the resolution this guard exists to
    // prevent, then confirm the guard actually rejects the value.
    expect(new URL('/\\evil.com', 'https://mysite.example/page').host).toBe(
      'evil.com',
    );
    expect(schema.safeParse('/\\evil.com').success).toBe(false);
    expect(schema.safeParse('//evil.example').success).toBe(false);
    expect(schema.safeParse('/safe/path').success).toBe(true);
  });
});

describe('json (field type)', () => {
  it('accepts an object and null, rejects a value over the byte cap', () => {
    const schema = buildValueSchema('json', {});
    expect(schema.safeParse({ a: [1, true, null] }).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);

    const oversized = { a: 'x'.repeat(70000) };
    const result = schema.safeParse(oversized) as ParseOutcome;
    expect(result.success).toBe(false);
    expect(failureIssues(result).length).toBeGreaterThan(0);
  });
});
