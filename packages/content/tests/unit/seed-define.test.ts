import { describe, expect, it } from 'vitest';
import {
  ContentTypeSeedError,
  defineContentTypes,
  SEED_ID_PATTERN,
  type SeedContentTypeInput,
} from '../../src/seed.js';

/** A minimal valid content type seed: one `short_text` and one `number`
 * field, reused as a base by several tests below. */
function baseType(
  overrides: Partial<SeedContentTypeInput> = {},
): SeedContentTypeInput {
  return {
    seedId: 'post',
    key: 'post',
    labelSingular: 'Post',
    labelPlural: 'Posts',
    fields: [
      { seedId: 'post.title', label: 'Title', fieldType: 'short_text' },
      { seedId: 'post.views', label: 'Views', fieldType: 'number' },
    ],
    ...overrides,
  };
}

/** Narrows a thrown value to `ContentTypeSeedError` and returns its
 * issues, without a conditional `expect(...)` call. */
function issuesOf(fn: () => unknown): readonly {
  readonly code: string;
  readonly seedId: string | null;
  readonly property?: string;
  readonly message: string;
}[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContentTypeSeedError) return error.issues;
    throw error;
  }
  throw new Error('expected defineContentTypes to throw');
}

describe('defineContentTypes (D-02): a valid seed', () => {
  it('validates, returns a frozen value, and leaves the input unmutated', () => {
    const input = [baseType()];
    const snapshot = JSON.parse(JSON.stringify(input));

    const seed = defineContentTypes(input);

    expect(seed).toHaveLength(1);
    expect(seed[0]?.key).toBe('post');
    expect(seed[0]?.fields).toHaveLength(2);
    expect(seed[0]?.fields[0]?.key).toBe('title');
    expect(seed[0]?.fields[0]?.fieldType).toBe('short_text');
    expect(input).toEqual(snapshot);
  });

  it('freezes every returned type and field (throws in strict mode on mutation)', () => {
    const seed = defineContentTypes([baseType()]);
    expect(() => {
      // @ts-expect-error -- intentionally violating the readonly field shape
      seed[0].fields[0].label = 'Changed';
    }).toThrow(TypeError);
  });
});

describe('defineContentTypes (D-02): compile-time option safety', () => {
  it('compiles with @ts-expect-error and still throws at runtime for a number field carrying short_text options', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.count',
              label: 'Count',
              fieldType: 'number',
              // @ts-expect-error -- { maxLength } is short_text's option, not number's
              options: { maxLength: 5 },
            },
          ],
        }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'INVALID_FIELD_OPTIONS')).toBe(
      true,
    );
  });

  it('compiles with @ts-expect-error and still throws at runtime for a short_text field carrying number options', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.title',
              label: 'Title',
              fieldType: 'short_text',
              // @ts-expect-error -- { min } is number's option, not short_text's
              options: { min: 3 },
            },
          ],
        }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'INVALID_FIELD_OPTIONS')).toBe(
      true,
    );
  });

  it('compiles with @ts-expect-error and still throws at runtime for a field type outside the sixteen', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.price',
              label: 'Price',
              // @ts-expect-error -- "currency" is not one of the sixteen registered field types
              fieldType: 'currency',
            },
          ],
        }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'UNKNOWN_FIELD_TYPE')).toBe(
      true,
    );
  });
});

describe('defineContentTypes (D-02): seed id rules', () => {
  it('rejects two types sharing a seed id', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({ seedId: 'dup', key: 'post' }),
        baseType({ seedId: 'dup', key: 'article' }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'DUPLICATE_SEED_ID')).toBe(
      true,
    );
  });

  it('rejects a type and a field sharing a seed id', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          seedId: 'shared',
          fields: [
            { seedId: 'shared', label: 'Title', fieldType: 'short_text' },
          ],
        }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'DUPLICATE_SEED_ID')).toBe(
      true,
    );
  });

  it('rejects a missing seed id and one breaking SEED_ID_PATTERN', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        {
          // @ts-expect-error -- seedId is a required property
          seedId: undefined,
          key: 'post',
          labelSingular: 'Post',
          labelPlural: 'Posts',
          fields: [],
        },
        baseType({ seedId: 'Not_Valid!', key: 'article' }),
      ]),
    );
    expect(
      issues.filter((issue) => issue.code === 'INVALID_SEED_ID'),
    ).toHaveLength(2);
  });

  it('SEED_ID_PATTERN accepts lowercase letters, digits, dots and hyphens', () => {
    expect(SEED_ID_PATTERN.test('post.title-1')).toBe(true);
    expect(SEED_ID_PATTERN.test('Post')).toBe(false);
    expect(SEED_ID_PATTERN.test('1post')).toBe(false);
  });
});

describe('defineContentTypes (D-02): field key rules', () => {
  it('derives a field key from its label when key is omitted', () => {
    const seed = defineContentTypes([
      baseType({
        fields: [
          {
            seedId: 'post.hero-image',
            label: 'Hero image',
            fieldType: 'short_text',
          },
        ],
      }),
    ]);
    expect(seed[0]?.fields[0]?.key).toBe('heroImage');
  });

  it('rejects an explicit key breaking FIELD_KEY_PATTERN', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.bad',
              label: 'Bad',
              key: 'Bad-Key!',
              fieldType: 'short_text',
            },
          ],
        }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'INVALID_FIELD_KEY')).toBe(
      true,
    );
  });

  it('rejects two fields of one type sharing a key', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.a',
              label: 'Title',
              key: 'title',
              fieldType: 'short_text',
            },
            {
              seedId: 'post.b',
              label: 'Title again',
              key: 'title',
              fieldType: 'short_text',
            },
          ],
        }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'DUPLICATE_FIELD_KEY')).toBe(
      true,
    );
  });
});

describe('defineContentTypes (D-02): runtime option validation matches the types', () => {
  it('rejects a select field with duplicate choice values', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.status',
              label: 'Status',
              fieldType: 'select',
              options: {
                choices: [
                  { value: 'draft', labels: { en: 'Draft' } },
                  { value: 'draft', labels: { en: 'Draft again' } },
                ],
              },
            },
          ],
        }),
      ]),
    );
    expect(
      issues.some(
        (issue) =>
          issue.code === 'INVALID_FIELD_OPTIONS' &&
          issue.seedId === 'post.status',
      ),
    ).toBe(true);
  });

  it("rejects a widget outside its field type's widget list", () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.title',
              label: 'Title',
              fieldType: 'short_text',
              widget: 'color-swatch',
            },
          ],
        }),
      ]),
    );
    expect(
      issues.some(
        (issue) =>
          issue.code === 'INVALID_WIDGET' && issue.seedId === 'post.title',
      ),
    ).toBe(true);
  });

  it('rejects a repeater holding a repeater sub-field', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          fields: [
            {
              seedId: 'post.items',
              label: 'Items',
              fieldType: 'repeater',
              options: {
                fields: [
                  {
                    key: 'inner',
                    label: 'Inner',
                    fieldType: 'repeater',
                    options: {
                      fields: [
                        { key: 'x', label: 'X', fieldType: 'short_text' },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
      ]),
    );
    expect(
      issues.some(
        (issue) =>
          issue.code === 'INVALID_FIELD_OPTIONS' &&
          issue.seedId === 'post.items',
      ),
    ).toBe(true);
  });
});

describe('defineContentTypes (D-02): type-level rules mirror creation', () => {
  it('rejects an empty label and an over-long label', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({ seedId: 'a', key: 'a', labelSingular: '   ' }),
        baseType({ seedId: 'b', key: 'b', labelPlural: 'x'.repeat(201) }),
      ]),
    );
    expect(issues.some((issue) => issue.code === 'EMPTY_LABEL')).toBe(true);
    expect(issues.some((issue) => issue.code === 'LABEL_TOO_LONG')).toBe(true);
  });

  it('rejects a type key breaking TYPE_KEY_PATTERN', () => {
    const issues = issuesOf(() =>
      defineContentTypes([baseType({ key: 'Not Valid' })]),
    );
    expect(issues.some((issue) => issue.code === 'INVALID_TYPE_KEY')).toBe(
      true,
    );
  });

  it('rejects revisions: true with no revisionMode', () => {
    const issues = issuesOf(() =>
      defineContentTypes([baseType({ revisions: true })]),
    );
    expect(
      issues.some((issue) => issue.code === 'REVISION_MODE_MISMATCH'),
    ).toBe(true);
  });

  it('rejects a singleton that is also routable', () => {
    const issues = issuesOf(() =>
      defineContentTypes([baseType({ singleton: true, routable: true })]),
    );
    expect(issues.some((issue) => issue.code === 'SINGLETON_ROUTABLE')).toBe(
      true,
    );
  });

  it('rejects a titleFieldKey naming no field of that type', () => {
    const issues = issuesOf(() =>
      defineContentTypes([baseType({ titleFieldKey: 'doesNotExist' })]),
    );
    expect(issues.some((issue) => issue.code === 'TITLE_FIELD_NOT_FOUND')).toBe(
      true,
    );
  });

  it('accepts a titleFieldKey naming a declared field', () => {
    const seed = defineContentTypes([baseType({ titleFieldKey: 'title' })]);
    expect(seed[0]?.titleFieldKey).toBe('title');
  });
});

describe('defineContentTypes (D-02): collect-then-throw-once', () => {
  it('every issue carries its seedId and a message naming the property', () => {
    const issues = issuesOf(() =>
      defineContentTypes([baseType({ key: 'Bad Key' })]),
    );
    const issue = issues.find((entry) => entry.code === 'INVALID_TYPE_KEY');
    expect(issue?.seedId).toBe('post');
    expect(issue?.message).toContain('key');
  });

  it('a config with five problems throws once with (at least) five issues', () => {
    const issues = issuesOf(() =>
      defineContentTypes([
        baseType({
          key: 'Bad Key', // 1: INVALID_TYPE_KEY
          labelSingular: '', // 2: EMPTY_LABEL
          singleton: true,
          routable: true, // 3: SINGLETON_ROUTABLE
          revisions: true, // 4: REVISION_MODE_MISMATCH
          titleFieldKey: 'missing', // 5: TITLE_FIELD_NOT_FOUND
        }),
      ]),
    );
    expect(issues.length).toBeGreaterThanOrEqual(5);
  });
});
