import { describe, expect, it } from 'vitest';
import { jsonFieldType } from '../../../src/field-types/json.js';
import { richTextFieldType } from '../../../src/field-types/rich-text.js';
import {
  exceedsNestingDepth,
  MAX_VALUE_NESTING_DEPTH,
} from '../../../src/field-types/value-depth.js';

/** A rich-text doc nested `depth` content levels deep. */
function nestedDoc(depth: number): unknown {
  let node: Record<string, unknown> = { type: 'paragraph' };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'paragraph', content: [node] };
  }
  return { type: 'doc', content: [node] };
}

/** A plain JSON value nested `depth` array levels deep. */
function nestedJson(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe('exceedsNestingDepth', () => {
  it('measures without recursing, so it survives a value that would overflow a recursive walk', () => {
    expect(exceedsNestingDepth(nestedJson(50_000))).toBe(true);
  });

  it('is exact at the cap boundary', () => {
    expect(exceedsNestingDepth(nestedJson(MAX_VALUE_NESTING_DEPTH - 1))).toBe(
      false,
    );
    expect(exceedsNestingDepth(nestedJson(MAX_VALUE_NESTING_DEPTH + 1))).toBe(
      true,
    );
  });

  it('ignores depth inside strings and leaves flat values alone', () => {
    expect(exceedsNestingDepth({ a: '['.repeat(10_000) })).toBe(false);
    expect(exceedsNestingDepth(null)).toBe(false);
    expect(exceedsNestingDepth(42)).toBe(false);
  });
});

describe('deeply nested values are rejected, never thrown (D-CR-02, D-CR-03)', () => {
  it('rich_text safeParse reports an issue instead of raising RangeError', () => {
    const schema = richTextFieldType.buildValueSchema({} as never);
    // About 25KB of payload used to blow the stack inside safeParse, which by
    // contract never throws, so a caller saw an uncaught RangeError.
    const result = schema.safeParse(nestedDoc(1200));
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => /nest deeper/.test(issue.message)),
    ).toBe(true);
  });

  it('json safeParse reports an issue instead of raising RangeError', () => {
    const schema = jsonFieldType.buildValueSchema({} as never);
    const result = schema.safeParse(nestedJson(2500));
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => /nest deeper/.test(issue.message)),
    ).toBe(true);
  });

  it('still accepts documents at the rich_text content-depth cap', () => {
    const schema = richTextFieldType.buildValueSchema({} as never);
    expect(schema.safeParse(nestedDoc(30)).success).toBe(true);
  });
});
