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
