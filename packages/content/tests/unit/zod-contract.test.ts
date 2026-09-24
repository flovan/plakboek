import { describe, expect, it } from 'vitest';
import { z } from 'zod';

type FailedParseIssue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

type ParseOutcome =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly FailedParseIssue[] };
    };

/**
 * Narrows a `safeParse` result to its failure branch without a conditional
 * `expect(...)` call (oxlint's vitest/no-conditional-expect forbids that) --
 * every test below asserts `result.success` is `false` first, then reads
 * issues through this helper.
 */
function failureIssues(result: ParseOutcome): readonly FailedParseIssue[] {
  if (result.success) {
    throw new Error('expected zod safeParse to fail');
  }
  return result.error.issues;
}

/**
 * Pins the zod v4 behaviours the field-type validation registry (plan
 * 03-03 onward) relies on. These are contract tests against the library
 * itself, not against this package's own code -- a change in any of these
 * behaviours on a future zod upgrade should fail loudly here before it
 * silently changes field-validation semantics.
 */
describe('zod v4 contract', () => {
  it('counts string length in Unicode code points, not UTF-16 code units', () => {
    expect(z.string().max(3).safeParse('ééé').success).toBe(true);
    expect(z.string().max(3).safeParse('éééé').success).toBe(false);
  });

  it('counts an astral character (outside the BMP) as one code point', () => {
    expect(z.string().max(1).safeParse('😀').success).toBe(true);
    expect(z.string().max(1).safeParse('😀😀').success).toBe(false);
  });

  it('z.int() rejects values outside the safe-integer range', () => {
    expect(z.int().safeParse(2 ** 53 - 1).success).toBe(true);
    expect(z.int().safeParse(2 ** 53).success).toBe(false);
  });

  it('z.number() rejects NaN and Infinity', () => {
    expect(z.number().safeParse(Number.NaN).success).toBe(false);
    expect(z.number().safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('z.strictObject() rejects unknown keys with an "unrecognized_keys" issue', () => {
    const result = z
      .strictObject({ a: z.string() })
      .safeParse({ a: 'x', b: 1 });
    expect(result.success).toBe(false);
    const issues = failureIssues(result);
    expect(issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(
      true,
    );
  });

  it('z.iso.date() rejects a calendar date that does not exist', () => {
    expect(z.iso.date().safeParse('2026-02-30').success).toBe(false);
  });

  it('a failed safeParse exposes issues carrying code, path and message', () => {
    const result = z.strictObject({ a: z.string() }).safeParse({ b: 1 });
    expect(result.success).toBe(false);
    const issues = failureIssues(result);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.code).toBe('string');
      expect(Array.isArray(issue.path)).toBe(true);
      expect(typeof issue.message).toBe('string');
    }
  });
});
