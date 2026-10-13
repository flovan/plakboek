import { describe, expect, it } from 'vitest';
import { definePagesConfig } from '../../src/config.js';
import {
  BUILT_IN_COLUMN_PRESETS,
  BlockLayoutValidationError,
  type BlockLayoutValidationIssue,
  COLUMN_RATIO_PATTERN,
  isEqualRatio,
  previewBlockValues,
  readStoredLayout,
  resolveColumnPresets,
  validateBlockLayout,
} from '../../src/layout.js';
import { defineBlocks, getBlockDefinition } from '../../src/registry.js';

const content = {
  locales: ['en'],
  defaultLocale: 'en',
  timezone: 'UTC',
} as const;

const blocks = defineBlocks([
  {
    key: 'column',
    kind: 'column',
    editor: { label: 'Column' },
    schemaVersion: 1,
    properties: {},
  },
  {
    key: 'section',
    kind: 'section',
    editor: { label: 'Section' },
    schemaVersion: 1,
    properties: {},
  },
  {
    key: 'quote',
    editor: { label: 'Quote' },
    schemaVersion: 1,
    properties: {
      text: {
        fieldType: 'short_text',
        label: 'Text',
        required: true,
        options: { maxLength: 40 },
      },
    },
    layout: { fill: true },
  },
  {
    key: 'text',
    editor: { label: 'Text' },
    schemaVersion: 1,
    properties: {},
  },
]);
const config = definePagesConfig({ content, blocks });
const section = getBlockDefinition('section');
const column = getBlockDefinition('column');
const quote = getBlockDefinition('quote');
const text = getBlockDefinition('text');
const presets = config.columnPresets;

function issuesOf(run: () => unknown): BlockLayoutValidationIssue[] {
  try {
    run();
  } catch (error) {
    if (error instanceof BlockLayoutValidationError) {
      return error.issues.map((issue) => ({ ...issue }));
    }
    throw error;
  }
  return [];
}

describe('resolveColumnPresets (D-05)', () => {
  it('returns the built-ins when nothing is configured', () => {
    expect(resolveColumnPresets()).toEqual({
      presets: [...BUILT_IN_COLUMN_PRESETS],
      issues: [],
    });
    expect(config.columnPresets).toEqual([...BUILT_IN_COLUMN_PRESETS]);
  });

  it('removes excluded built-ins, then appends additions, in order', () => {
    const { presets: resolved, issues } = resolveColumnPresets({
      exclude: ['2:1', '1:1:2'],
      add: ['3:1', '1:3'],
    });
    expect(issues).toEqual([]);
    expect(resolved).not.toContain('2:1');
    expect(resolved).not.toContain('1:1:2');
    expect(resolved.slice(-2)).toEqual(['3:1', '1:3']);
  });

  it('reports every problem instead of stopping at the first', () => {
    const { issues } = resolveColumnPresets({
      exclude: ['1:1', '5:1', 'x'],
      add: ['2:1', '4:4', '3:1', '3:1', 'bad'],
    });
    expect(issues).toHaveLength(7);
  });
});

describe('isEqualRatio and the ratio pattern', () => {
  it('treats a ratio of equal terms as the equal split', () => {
    expect(isEqualRatio('1')).toBe(true);
    expect(isEqualRatio('2:2:2')).toBe(true);
    expect(isEqualRatio('2:1')).toBe(false);
  });

  it('accepts only colon-separated positive integers', () => {
    expect(COLUMN_RATIO_PATTERN.test('2:1:1')).toBe(true);
    expect(COLUMN_RATIO_PATTERN.test('0:1')).toBe(false);
    expect(COLUMN_RATIO_PATTERN.test('2:')).toBe(false);
    expect(COLUMN_RATIO_PATTERN.test('1fr:2fr')).toBe(false);
  });
});

describe('validateBlockLayout (D-04, D-08, D-33)', () => {
  it('treats null and undefined as no layout', () => {
    expect(validateBlockLayout(section, null, presets)).toBeNull();
    expect(validateBlockLayout(section, undefined, presets)).toBeNull();
  });

  it('keeps a known preset and a non-default alignment on a section', () => {
    expect(
      validateBlockLayout(section, { columns: '2:1', align: 'end' }, presets),
    ).toEqual({ columns: '2:1', align: 'end' });
  });

  it('normalises an equal ratio, stretch and fill false to absent', () => {
    expect(
      validateBlockLayout(
        section,
        { columns: '1:1:1', align: 'stretch' },
        presets,
      ),
    ).toBeNull();
    expect(validateBlockLayout(quote, { fill: false }, presets)).toBeNull();
    expect(validateBlockLayout(quote, { fill: true }, presets)).toEqual({
      fill: true,
    });
  });

  it('allows an equal split for any count even though it is not a preset', () => {
    expect(
      validateBlockLayout(section, { columns: '1:1:1:1:1:1' }, presets),
    ).toBeNull();
  });

  it('refuses a ratio outside the presets, a bad alignment and non-boolean fill', () => {
    expect(
      issuesOf(() => validateBlockLayout(section, { columns: '9:1' }, presets)),
    ).toEqual([{ key: 'columns', code: 'INVALID' }]);
    expect(
      issuesOf(() => validateBlockLayout(section, { columns: 2 }, presets)),
    ).toEqual([{ key: 'columns', code: 'INVALID' }]);
    expect(
      issuesOf(() =>
        validateBlockLayout(section, { align: 'middle' }, presets),
      ),
    ).toEqual([{ key: 'align', code: 'INVALID' }]);
    expect(
      issuesOf(() => validateBlockLayout(quote, { fill: 'yes' }, presets)),
    ).toEqual([{ key: 'fill', code: 'INVALID' }]);
  });

  it('refuses keys the block kind does not take', () => {
    expect(
      issuesOf(() => validateBlockLayout(text, { fill: true }, presets)),
    ).toEqual([{ key: 'fill', code: 'UNKNOWN' }]);
    expect(
      issuesOf(() => validateBlockLayout(column, { columns: '2:1' }, presets)),
    ).toEqual([{ key: 'columns', code: 'UNKNOWN' }]);
    expect(
      issuesOf(() => validateBlockLayout(quote, { columns: '2:1' }, presets)),
    ).toEqual([{ key: 'columns', code: 'UNKNOWN' }]);
    expect(
      issuesOf(() => validateBlockLayout(section, { x: 1 }, presets)),
    ).toEqual([{ key: 'x', code: 'UNKNOWN' }]);
  });

  it('refuses a layout that is not an object, collecting every issue otherwise', () => {
    expect(issuesOf(() => validateBlockLayout(section, [1], presets))).toEqual([
      { key: '*', code: 'INVALID' },
    ]);
    expect(
      issuesOf(() =>
        validateBlockLayout(section, { columns: '9:1', x: 1 }, presets),
      ),
    ).toHaveLength(2);
  });

  it('never echoes a submitted value in the error message', () => {
    const error = new BlockLayoutValidationError(
      issuesOf(() =>
        validateBlockLayout(section, { columns: '97:3' }, presets),
      ),
    );
    expect(error.issues).toEqual([{ key: 'columns', code: 'INVALID' }]);
    expect(error.message).not.toContain('97:3');
  });

  it('only gates new writes: a changed preset list never changes how a stored layout reads', () => {
    const narrowed = definePagesConfig({
      content,
      blocks,
      columnPresets: { exclude: ['2:1'] },
    });
    expect(
      issuesOf(() =>
        validateBlockLayout(
          section,
          { columns: '2:1' },
          narrowed.columnPresets,
        ),
      ),
    ).toEqual([{ key: 'columns', code: 'INVALID' }]);
    expect(readStoredLayout({ columns: '2:1' })).toEqual({ columns: '2:1' });
  });
});

describe('readStoredLayout', () => {
  it('keeps only the keys and shapes this package writes', () => {
    expect(
      readStoredLayout({ columns: '2:1', align: 'end', fill: true, x: 1 }),
    ).toEqual({
      columns: '2:1',
      align: 'end',
      fill: true,
    });
    expect(
      readStoredLayout({ columns: 3, align: 'middle', fill: 'yes' }),
    ).toBeNull();
    expect(readStoredLayout(null)).toBeNull();
    expect(readStoredLayout([1])).toBeNull();
  });
});

describe('previewBlockValues (D-20, D-24)', () => {
  it('answers with the normalised values and the required properties still empty', () => {
    const outcome = previewBlockValues(config, {
      blockType: 'quote',
      props: {},
      layout: { fill: true },
    });
    expect(outcome).toEqual({
      ok: true,
      props: {},
      layout: { fill: true },
      missingRequired: ['text'],
    });
  });

  it('returns no missing values once the property has one', () => {
    const outcome = previewBlockValues(config, {
      blockType: 'quote',
      props: { text: 'Hi' },
      layout: null,
    });
    expect(outcome).toEqual({
      ok: true,
      props: { text: 'Hi' },
      layout: null,
      missingRequired: [],
    });
  });

  it('refuses an unknown type with the unknown-type code', () => {
    expect(
      previewBlockValues(config, {
        blockType: 'made_up',
        props: {},
        layout: null,
      }),
    ).toEqual({ ok: false, issues: [{ key: '*', code: 'UNKNOWN_TYPE' }] });
  });

  it('collects props and layout issues together, naming keys and codes only', () => {
    const outcome = previewBlockValues(config, {
      blockType: 'quote',
      props: { text: 5, nope: 1 },
      layout: { columns: '2:1' },
    });
    expect(outcome).toEqual({
      ok: false,
      issues: [
        { key: 'nope', code: 'UNKNOWN' },
        { key: 'text', code: 'INVALID' },
        { key: 'columns', code: 'UNKNOWN' },
      ],
    });
  });
});
