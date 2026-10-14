import { describe, expect, it } from 'vitest';
import type { CatalogueEntry } from '../../src/api-types.js';
import {
  defaultNode,
  insertActionFor,
  insertionTarget,
  insertSlots,
  paletteGroups,
  pickerGroups,
  slotAfter,
  soleSectionType,
} from '../../src/client/session/insertion.js';
import type { LegalityContext } from '../../src/client/session/legality.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import {
  block,
  buildNodes,
  catalogueEntry,
  column,
  section,
  type Spec,
} from './support/model.js';

function entry(
  key: string,
  kind: 'section' | 'column' | 'block',
  editor: Partial<CatalogueEntry['editor']> = {},
  placement: Partial<CatalogueEntry['placement']> = {},
): CatalogueEntry {
  const base = catalogueEntry(key, kind, placement);
  return { ...base, editor: { ...base.editor, ...editor } };
}

const entries: readonly CatalogueEntry[] = [
  entry('section', 'section'),
  entry('column', 'column'),
  entry('heading', 'block', { label: 'Heading', category: 'Content' }),
  entry('text', 'block', {
    label: 'Text',
    description: 'A paragraph of prose',
    category: 'Content',
  }),
  entry('hero', 'block', { label: 'Hero', category: 'Marketing' }),
  entry('spacer', 'block', { label: 'Spacer' }),
  entry('banner', 'block', { label: 'Banner' }, { allowedParents: ['@root'] }),
  {
    ...entry('card', 'block', { label: 'Card' }, { allowedChildren: 'any' }),
    properties: [
      {
        key: 'title',
        label: 'Title',
        fieldType: 'short_text',
        widget: 'text-input',
        required: true,
        options: {},
        constraint: 'none',
      },
      {
        key: 'tone',
        label: 'Tone',
        fieldType: 'short_text',
        widget: 'text-input',
        required: false,
        defaultValue: 'calm',
        options: {},
        constraint: 'none',
      },
    ],
  },
];

// A: ca [h1, h2, c1 [h3]]   B: cb []
const roots: readonly Spec[] = [
  section('A', [
    column('ca', [
      block('h1', 'heading'),
      block('h2', 'heading'),
      block('c1', 'card', [block('h3', 'heading')]),
    ]),
  ]),
  section('B', [column('cb')]),
];
const model = createTreeModel(buildNodes(roots));

const ctx: LegalityContext = {
  catalogue: new Map(entries.map((item) => [item.key, item])),
  model,
  limits: { sectionNestingDepth: 1, blockDepthCeiling: 12 },
  columnsEnabled: true,
};

describe('insert slots', () => {
  it('lists the gaps of the page: above, between and below the sections', () => {
    const slots = insertSlots(ctx, null);
    expect(slots.map((slot) => [slot.previousId, slot.nextId])).toEqual([
      [null, 'A'],
      ['A', 'B'],
      ['B', null],
    ]);
    expect(slots.every((slot) => slot.level === 'section')).toBe(true);
  });

  it('lists the gaps of a column as block gaps and of a block as item gaps', () => {
    const inColumn = insertSlots(ctx, 'ca');
    expect(inColumn).toHaveLength(4);
    expect(inColumn.every((slot) => slot.level === 'block')).toBe(true);
    expect(insertSlots(ctx, 'c1').every((slot) => slot.level === 'item')).toBe(
      true,
    );
  });

  it('gives an empty container its one gap, and a section none: its columns have their own tools', () => {
    expect(insertSlots(ctx, 'cb')).toEqual([
      { parentId: 'cb', previousId: null, nextId: null, level: 'block' },
    ]);
    expect(insertSlots(ctx, 'A')).toEqual([]);
  });

  it('finds the gap after an item, and none after a column', () => {
    expect(slotAfter(ctx, 'h1')).toEqual({
      parentId: 'ca',
      previousId: 'h1',
      nextId: 'h2',
      level: 'block',
    });
    expect(slotAfter(ctx, 'c1')?.nextId).toBeNull();
    expect(slotAfter(ctx, 'ca')).toBeNull();
    expect(slotAfter(ctx, null)).toEqual({
      parentId: null,
      previousId: 'B',
      nextId: null,
      level: 'section',
    });
  });
});

describe('the picker types', () => {
  const columnGap = insertSlots(ctx, 'ca')[1]!;
  const pageGap = insertSlots(ctx, null)[0]!;
  const keysOf = (groups: ReturnType<typeof pickerGroups>): string[] =>
    groups.flatMap((group) => group.entries.map((item) => item.key));

  it('lists only the types legal in the gap, never the column', () => {
    expect(keysOf(pickerGroups(ctx, columnGap, ''))).toEqual([
      'heading',
      'text',
      'hero',
      'spacer',
      'card',
    ]);
    // a root-only block is legal at the page root only if a section; banner needs a section parent
    expect(keysOf(pickerGroups(ctx, pageGap, ''))).toEqual(['section']);
  });

  it('groups by category in catalogue order with the uncategorised last, as Other', () => {
    expect(
      pickerGroups(ctx, columnGap, '').map((group) => group.category),
    ).toEqual(['Content', 'Marketing', 'Other']);
  });

  it('searches label, description and key without regard to case', () => {
    expect(keysOf(pickerGroups(ctx, columnGap, 'TEX'))).toEqual(['text']);
    expect(keysOf(pickerGroups(ctx, columnGap, 'prose'))).toEqual(['text']);
    expect(keysOf(pickerGroups(ctx, columnGap, 'spac'))).toEqual(['spacer']);
    expect(pickerGroups(ctx, columnGap, 'nothing like this')).toEqual([]);
  });

  it('skips the picker for a section gap with exactly one legal type', () => {
    expect(soleSectionType(ctx, pageGap)?.key).toBe('section');
    expect(soleSectionType(ctx, columnGap)).toBeNull();
  });

  it('lists every type but the column in the palette', () => {
    expect(
      paletteGroups(ctx, '').flatMap((group) =>
        group.entries.map((item) => item.key),
      ),
    ).toEqual([
      'heading',
      'text',
      'hero',
      'section',
      'spacer',
      'banner',
      'card',
    ]);
  });
});

describe('where a palette row lands', () => {
  it('puts a block right after the selected block', () => {
    expect(
      insertionTarget(ctx, { scopeId: 'ca', selectedId: 'h1' }, 'text'),
    ).toEqual({ parentId: 'ca', previousId: 'h1', nextId: 'h2' });
  });

  it('climbs to the nearest level where the type is legal', () => {
    // a selected column cannot take a text after it, nor can its section or the page
    expect(
      insertionTarget(ctx, { scopeId: 'A', selectedId: 'ca' }, 'text'),
    ).toBeNull();
    // a section type after a heading climbs out of the column and the section
    expect(
      insertionTarget(ctx, { scopeId: 'ca', selectedId: 'h2' }, 'section'),
    ).toEqual({ parentId: null, previousId: 'A', nextId: 'B' });
  });

  it('sends a section type to the end of the page when nothing is selected, and has no place for anything else', () => {
    const nothing = { scopeId: null, selectedId: null };
    expect(insertionTarget(ctx, nothing, 'section')).toEqual({
      parentId: null,
      previousId: 'B',
      nextId: null,
    });
    expect(insertionTarget(ctx, nothing, 'text')).toBeNull();
  });

  it('never places a column', () => {
    expect(
      insertionTarget(ctx, { scopeId: 'A', selectedId: 'ca' }, 'column'),
    ).toBeNull();
  });
});

describe('a new item', () => {
  const card = entries.find((item) => item.key === 'card')!;

  it('starts with each property default, no children and the minted id', () => {
    expect(defaultNode(card, 'new-1')).toEqual({
      id: 'new-1',
      type: 'card',
      props: { tone: 'calm' },
    });
    expect(defaultNode(entries[2]!, 'new-2')).toEqual({
      id: 'new-2',
      type: 'heading',
    });
  });

  it('is an insert with an undo entry that deletes it', () => {
    const action = insertActionFor(
      model,
      card,
      { parentId: 'ca', previousId: 'h1', nextId: 'h2' },
      'new-1',
    );
    expect(action.intent.kind).toBe('insert');
    expect(action.entry.action).toEqual({ kind: 'added', itemId: 'new-1' });
    expect(action.entry.inverse).toEqual({ kind: 'delete', blockId: 'new-1' });
  });
});
