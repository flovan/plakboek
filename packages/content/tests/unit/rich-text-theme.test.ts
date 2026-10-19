import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_THEME,
  findWideningNarrowing,
  narrowTextTheme,
  resolveTextTheme,
  TextThemeError,
  textThemeNarrowingSchema,
  type TextThemeInput,
  type TextThemeIssue,
} from '../../src/rich-text/index.js';

const palette = {
  colors: [
    { label: 'Text', token: 'text' },
    { label: 'Accent', token: 'accent' },
  ],
  sizes: [
    { label: 'Small', token: 'sm', value: '14px' },
    { label: 'Large', token: 'xl' },
  ],
  align: true,
} satisfies TextThemeInput;

function issuesOf(input: unknown): readonly TextThemeIssue[] {
  try {
    resolveTextTheme(input as TextThemeInput);
  } catch (error) {
    if (error instanceof TextThemeError) return error.issues;
    throw error;
  }
  return [];
}

function codesOf(input: unknown): string[] {
  return [...new Set(issuesOf(input).map((issue) => issue.code))].toSorted();
}

describe('resolveTextTheme defaults (D-09, D-12)', () => {
  it('gives the lean set with no unlock palettes and no alignment', () => {
    const theme = resolveTextTheme();
    expect(theme.marks).toEqual([
      'bold',
      'italic',
      'underline',
      'strike',
      'link',
    ]);
    expect(theme.nodes).toEqual([
      'bulletList',
      'orderedList',
      'blockquote',
      'horizontalRule',
      'hardBreak',
      'cta',
    ]);
    expect(theme.headingLevels).toEqual([2, 3, 4]);
    expect(theme.colors).toEqual([]);
    expect(theme.sizes).toEqual([]);
    expect(theme.align).toBe(false);
    expect(theme.allowCustomValues).toBe(true);
    expect(theme.ctaVariants).toEqual([
      { label: 'Primary', value: 'primary' },
      { label: 'Secondary', value: 'secondary' },
    ]);
    expect(theme).toEqual(DEFAULT_TEXT_THEME);
  });

  it('fills only the missing keys and keeps what the host set', () => {
    const theme = resolveTextTheme({ ...palette, headingLevels: [2] });
    expect(theme.headingLevels).toEqual([2]);
    expect(theme.colors.map((entry) => entry.token)).toEqual([
      'text',
      'accent',
    ]);
    expect(theme.sizes[0]).toEqual({
      label: 'Small',
      token: 'sm',
      value: '14px',
    });
    expect(theme.align).toBe(true);
    expect(theme.marks).toEqual(DEFAULT_TEXT_THEME.marks);
  });

  it('freezes the result deeply, and does not share state with the input', () => {
    const input = { colors: [{ label: 'Text', token: 'text' }] };
    const theme = resolveTextTheme(input);
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.marks)).toBe(true);
    expect(Object.isFrozen(theme.colors)).toBe(true);
    expect(Object.isFrozen(theme.colors[0])).toBe(true);
    expect(Object.isFrozen(theme.ctaVariants[0])).toBe(true);
    expect(theme.colors[0]).not.toBe(input.colors[0]);
    expect(Object.isFrozen(DEFAULT_TEXT_THEME)).toBe(true);
  });
});

describe('resolveTextTheme refusals', () => {
  it('refuses an unknown mark or node name', () => {
    expect(codesOf({ marks: ['bold', 'code'] })).toEqual(['UNKNOWN_MARK']);
    expect(codesOf({ nodes: ['codeBlock'] })).toEqual(['UNKNOWN_NODE']);
  });

  it('refuses a heading level outside 2 to 4, so level 1 is never available', () => {
    expect(codesOf({ headingLevels: [1] })).toEqual(['INVALID_HEADING_LEVEL']);
    expect(codesOf({ headingLevels: [5] })).toEqual(['INVALID_HEADING_LEVEL']);
    expect(codesOf({ headingLevels: ['2'] })).toEqual([
      'INVALID_HEADING_LEVEL',
    ]);
    expect(issuesOf({ headingLevels: [] })).toEqual([]);
  });

  it('refuses duplicate names', () => {
    expect(codesOf({ marks: ['bold', 'bold'] })).toEqual(['DUPLICATE_NAME']);
    expect(codesOf({ nodes: ['blockquote', 'blockquote'] })).toEqual([
      'DUPLICATE_NAME',
    ]);
    expect(codesOf({ headingLevels: [2, 2] })).toEqual(['DUPLICATE_NAME']);
  });

  it('refuses a palette or variant entry with a blank or over-long label', () => {
    expect(codesOf({ colors: [{ label: '  ', token: 'a' }] })).toEqual([
      'INVALID_LABEL',
    ]);
    expect(codesOf({ sizes: [{ label: 'x'.repeat(81), token: 'a' }] })).toEqual(
      ['INVALID_LABEL'],
    );
    expect(codesOf({ ctaVariants: [{ label: '', value: 'primary' }] })).toEqual(
      ['INVALID_LABEL'],
    );
    expect(
      issuesOf({ colors: [{ label: 'x'.repeat(80), token: 'a' }] }),
    ).toEqual([]);
  });

  it('refuses a token that fails the token pattern or repeats within its palette', () => {
    for (const token of ['Accent', '3xl', 'a b', '', 'a'.repeat(65)]) {
      expect(codesOf({ colors: [{ label: 'L', token }] })).toEqual([
        'INVALID_TOKEN',
      ]);
    }
    expect(
      codesOf({
        sizes: [
          { label: 'A', token: 'sm' },
          { label: 'B', token: 'sm' },
        ],
      }),
    ).toEqual(['DUPLICATE_TOKEN']);
    expect(
      issuesOf({
        colors: [{ label: 'A', token: 'sm' }],
        sizes: [{ label: 'B', token: 'sm' }],
      }),
    ).toEqual([]);
  });

  it('refuses a size value that is not a px string', () => {
    for (const value of ['1.5rem', '14', 14, 'big', '14px; color: red']) {
      expect(codesOf({ sizes: [{ label: 'A', token: 'a', value }] })).toEqual([
        'INVALID_SIZE_VALUE',
      ]);
    }
  });

  it('refuses a variant value that fails the token pattern or repeats', () => {
    expect(codesOf({ ctaVariants: [{ label: 'A', value: 'Big' }] })).toEqual([
      'INVALID_TOKEN',
    ]);
    expect(
      codesOf({
        ctaVariants: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'a' },
        ],
      }),
    ).toEqual(['DUPLICATE_TOKEN']);
  });

  it('refuses cta in nodes with no variants, and accepts it once cta is dropped', () => {
    expect(codesOf({ ctaVariants: [] })).toEqual(['CTA_WITHOUT_VARIANTS']);
    expect(issuesOf({ ctaVariants: [], nodes: ['blockquote'] })).toEqual([]);
  });

  it('refuses values of the wrong type', () => {
    expect(codesOf({ marks: 'bold' })).toEqual(['INVALID_SHAPE']);
    expect(codesOf({ align: 'yes' })).toEqual(['INVALID_SHAPE']);
    expect(codesOf({ colors: ['accent'] })).toEqual(['INVALID_SHAPE']);
    expect(codesOf('theme')).toEqual(['INVALID_SHAPE']);
  });

  it('collects every problem before throwing', () => {
    expect(
      codesOf({
        marks: ['code'],
        headingLevels: [1],
        colors: [{ label: '', token: 'Bad' }],
      }),
    ).toEqual([
      'INVALID_HEADING_LEVEL',
      'INVALID_LABEL',
      'INVALID_TOKEN',
      'UNKNOWN_MARK',
    ]);
  });

  it('quotes at most 64 printable characters of what it refuses', () => {
    const long = `${'z'.repeat(200)}\u0007`;
    const message = issuesOf({ marks: [long] })
      .map((issue) => issue.message)
      .join('\n');
    expect(message).toContain('z'.repeat(64));
    expect(message).not.toContain('z'.repeat(65));
    expect(message).not.toContain('\u0007');
  });

  it('puts every message in the error message too', () => {
    expect(() => resolveTextTheme({ headingLevels: [1] as never })).toThrow(
      TextThemeError,
    );
  });
});

describe('narrowTextTheme (D-06: intersection only)', () => {
  const full = resolveTextTheme(palette);

  it('keeps only the named marks and every node', () => {
    const narrowed = narrowTextTheme(DEFAULT_TEXT_THEME, {
      marks: ['bold', 'italic', 'link'],
    });
    expect(narrowed.marks).toEqual(['bold', 'italic', 'link']);
    expect(narrowed.nodes).toEqual(DEFAULT_TEXT_THEME.nodes);
  });

  it('returns the theme unchanged for no narrowing', () => {
    expect(narrowTextTheme(full)).toEqual(full);
    expect(narrowTextTheme(full, {})).toEqual(full);
  });

  it('drops nodes and heading levels', () => {
    const narrowed = narrowTextTheme(full, {
      nodes: ['bulletList'],
      headingLevels: [3],
    });
    expect(narrowed.nodes).toEqual(['bulletList']);
    expect(narrowed.headingLevels).toEqual([3]);
    expect(narrowTextTheme(full, { headingLevels: [] }).headingLevels).toEqual(
      [],
    );
  });

  it('switches palettes, alignment and custom values off', () => {
    const narrowed = narrowTextTheme(full, {
      colors: false,
      sizes: false,
      align: false,
      allowCustomValues: false,
    });
    expect(narrowed.colors).toEqual([]);
    expect(narrowed.sizes).toEqual([]);
    expect(narrowed.align).toBe(false);
    expect(narrowed.allowCustomValues).toBe(false);
    expect(narrowTextTheme(full, { colors: true }).colors).toEqual(full.colors);
  });

  it('keeps one variant, and drops the cta node with the last of them', () => {
    const one = narrowTextTheme(full, { ctaVariants: ['primary'] });
    expect(one.ctaVariants).toEqual([{ label: 'Primary', value: 'primary' }]);
    expect(one.nodes).toContain('cta');
    const none = narrowTextTheme(full, { ctaVariants: [] });
    expect(none.ctaVariants).toEqual([]);
    expect(none.nodes).not.toContain('cta');
  });

  it('never adds anything the theme lacks', () => {
    const lean = resolveTextTheme({
      marks: ['bold'],
      nodes: [],
      headingLevels: [2],
    });
    const narrowed = narrowTextTheme(lean, {
      marks: ['bold', 'italic'],
      nodes: ['blockquote'],
      headingLevels: [2, 3],
      colors: true,
      sizes: true,
      align: true,
    });
    expect(narrowed.marks).toEqual(['bold']);
    expect(narrowed.nodes).toEqual([]);
    expect(narrowed.headingLevels).toEqual([2]);
    expect(narrowed.colors).toEqual([]);
    expect(narrowed.sizes).toEqual([]);
    expect(narrowed.align).toBe(false);
  });

  it('keeps custom values off once a theme turned them off', () => {
    const off = resolveTextTheme({ allowCustomValues: false });
    expect(
      narrowTextTheme(off, { allowCustomValues: true }).allowCustomValues,
    ).toBe(false);
  });

  it('freezes its result and leaves the theme it was given alone', () => {
    const narrowed = narrowTextTheme(full, { marks: ['bold'] });
    expect(Object.isFrozen(narrowed)).toBe(true);
    expect(Object.isFrozen(narrowed.marks)).toBe(true);
    expect(full.marks).toEqual(DEFAULT_TEXT_THEME.marks);
  });
});

describe('findWideningNarrowing', () => {
  const full = resolveTextTheme(palette);

  it('names nothing for a pure subset', () => {
    expect(
      findWideningNarrowing(full, {
        marks: ['bold'],
        nodes: ['cta'],
        headingLevels: [2],
        colors: false,
        sizes: true,
        align: false,
        allowCustomValues: false,
        ctaVariants: ['primary'],
      }),
    ).toEqual([]);
    expect(findWideningNarrowing(full)).toEqual([]);
  });

  it('names a colour palette the theme does not have', () => {
    const lean = resolveTextTheme();
    expect(findWideningNarrowing(lean, { colors: true })).toEqual(['colors']);
    expect(findWideningNarrowing(lean, { sizes: true, align: true })).toEqual([
      'sizes',
      'align',
    ]);
  });

  it('names a mark, a node, a heading level and a variant outside the theme', () => {
    const narrow = resolveTextTheme({
      marks: ['bold'],
      nodes: ['blockquote'],
      headingLevels: [2],
    });
    expect(
      findWideningNarrowing(narrow, {
        marks: ['bold', 'code'] as never,
        nodes: ['blockquote', 'cta'],
        headingLevels: [1, 2] as never,
        ctaVariants: ['tertiary'],
      }),
    ).toEqual([
      'marks: code',
      'nodes: cta',
      'headingLevels: 1',
      'ctaVariants: tertiary',
    ]);
  });

  it('names custom values switched on where the theme has them off', () => {
    const off = resolveTextTheme({ allowCustomValues: false });
    expect(findWideningNarrowing(off, { allowCustomValues: true })).toEqual([
      'allowCustomValues',
    ]);
    expect(findWideningNarrowing(full, { allowCustomValues: true })).toEqual(
      [],
    );
  });

  it('quotes at most 64 printable characters of a name', () => {
    const [entry] = findWideningNarrowing(full, {
      ctaVariants: [`${'v'.repeat(200)}\u0007`],
    });
    expect(entry).toContain('v'.repeat(64));
    expect(entry).not.toContain('v'.repeat(65));
    expect(entry).not.toContain('\u0007');
  });
});

describe('textThemeNarrowingSchema', () => {
  it('accepts the narrowing shape', () => {
    expect(
      textThemeNarrowingSchema.parse({
        marks: ['bold'],
        nodes: ['cta'],
        headingLevels: [2, 3],
        colors: false,
        sizes: false,
        align: false,
        allowCustomValues: false,
        ctaVariants: ['primary'],
      }),
    ).toEqual({
      marks: ['bold'],
      nodes: ['cta'],
      headingLevels: [2, 3],
      colors: false,
      sizes: false,
      align: false,
      allowCustomValues: false,
      ctaVariants: ['primary'],
    });
    expect(textThemeNarrowingSchema.parse({})).toEqual({});
  });

  it('refuses unknown keys and values of the wrong kind', () => {
    for (const value of [
      { fonts: ['serif'] },
      { marks: ['code'] },
      { headingLevels: [1] },
      { colors: ['accent'] },
      { align: 'center' },
      { ctaVariants: [1] },
    ]) {
      expect(textThemeNarrowingSchema.safeParse(value).success).toBe(false);
    }
  });
});
