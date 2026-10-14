import { describe, expect, it } from 'vitest';
import type { ModelLayout } from '../../src/api-types.js';
import {
  addColumnIntent,
  duplicateColumnIntent,
  layoutIntent,
  moveColumnIntent,
  normalizeLayout,
  removeColumnIntent,
} from '../../src/client/session/column-actions.js';
import { buildUndoEntry } from '../../src/client/session/inverse.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

/** A: three columns on 2:1:1 with a centre alignment. B: one column. */
function modelWith(layouts: Readonly<Record<string, ModelLayout>> = {}) {
  const nodes = buildNodes([
    section('A', [
      column('a1', [block('t1', 'text'), block('t2', 'text')]),
      column('a2'),
      column('a3'),
    ]),
    section('B', [column('b1')]),
  ]).map((node) =>
    layouts[node.id] === undefined
      ? node
      : { ...node, layout: layouts[node.id] ?? null },
  );
  return createTreeModel(nodes);
}

const model = modelWith({ A: { columns: '2:1:1', align: 'center' } });

describe('layout normalisation', () => {
  it('stores the equal split, stretch and a fill of false as absent', () => {
    expect(
      normalizeLayout({ columns: '1:1', align: 'stretch', fill: false }),
    ).toBe(null);
    expect(normalizeLayout({ columns: '2:1', align: 'stretch' })).toEqual({
      columns: '2:1',
    });
    expect(normalizeLayout({ align: 'end', fill: true })).toEqual({
      align: 'end',
      fill: true,
    });
    expect(normalizeLayout(undefined)).toBeNull();
  });
});

describe('adding a column', () => {
  it('is one group: the new column right after the named one, then the equal split with the alignment kept', () => {
    const intent = addColumnIntent(model, 'A', 'a1', 'new');
    expect(intent).toEqual({
      kind: 'group',
      intents: [
        {
          kind: 'insert',
          position: { parentId: 'A', previousId: 'a1', nextId: 'a2' },
          node: { id: 'new', type: 'column' },
        },
        { kind: 'update', blockId: 'A', layout: { align: 'center' } },
      ],
    });
  });

  it('puts the column last when none is named, and clears a layout that is left with nothing', () => {
    const intent = addColumnIntent(
      modelWith({ A: { columns: '1:2:1' } }),
      'A',
      null,
      'new',
    );
    expect(intent).toMatchObject({
      intents: [
        { position: { parentId: 'A', previousId: 'a3', nextId: null } },
        { kind: 'update', blockId: 'A', layout: null },
      ],
    });
  });

  it('is undone by one group that restores the layout and deletes the column', () => {
    const intent = addColumnIntent(model, 'A', null, 'new');
    const entry = buildUndoEntry(intent, model, {
      kind: 'added',
      itemId: 'new',
    });
    expect(entry.inverse).toEqual({
      kind: 'group',
      intents: [
        {
          kind: 'update',
          blockId: 'A',
          layout: { columns: '2:1:1', align: 'center' },
        },
        { kind: 'delete', blockId: 'new' },
      ],
    });
  });
});

describe('removing a column', () => {
  it('refuses a section its only column, and anything that is not a column', () => {
    expect(removeColumnIntent(model, 'b1')).toBeNull();
    expect(removeColumnIntent(model, 't1')).toBeNull();
    expect(removeColumnIntent(model, 'A')).toBeNull();
  });

  it('is one group: the delete, then the equal split with the alignment kept', () => {
    expect(removeColumnIntent(model, 'a2')).toEqual({
      kind: 'group',
      intents: [
        { kind: 'delete', blockId: 'a2' },
        { kind: 'update', blockId: 'A', layout: { align: 'center' } },
      ],
    });
  });

  it('is undone by restoring the layout and the column with what it held', () => {
    const intent = removeColumnIntent(model, 'a1');
    if (intent === null) throw new Error('expected a removal');
    const entry = buildUndoEntry(intent, model, {
      kind: 'deleted',
      itemId: 'a1',
    });
    expect(entry.requiresDelete).toBe(true);
    expect(entry.inverse).toMatchObject({
      kind: 'group',
      intents: [
        {
          kind: 'update',
          blockId: 'A',
          layout: { columns: '2:1:1', align: 'center' },
        },
        {
          kind: 'insert',
          position: { parentId: 'A', previousId: null, nextId: 'a2' },
          node: { id: 'a1', children: [{ id: 't1' }, { id: 't2' }] },
        },
      ],
    });
  });
});

describe('copying a column', () => {
  it('is one group: the copy right after it, then the equal split', () => {
    expect(duplicateColumnIntent(model, 'a1', 'copy')).toEqual({
      kind: 'group',
      intents: [
        { kind: 'duplicate', blockId: 'a1', newId: 'copy' },
        { kind: 'update', blockId: 'A', layout: { align: 'center' } },
      ],
    });
    expect(duplicateColumnIntent(model, 't1', 'copy')).toBeNull();
  });
});

describe('moving a column', () => {
  it('is a plain move inside its section: the count does not change', () => {
    const position = { parentId: 'A', previousId: 'a3', nextId: null };
    expect(moveColumnIntent(model, 'a1', position)).toEqual({
      kind: 'move',
      blockId: 'a1',
      position,
    });
  });

  it('resets both sections when it changes section', () => {
    const position = { parentId: 'B', previousId: null, nextId: 'b1' };
    expect(moveColumnIntent(model, 'a3', position)).toEqual({
      kind: 'group',
      intents: [
        { kind: 'move', blockId: 'a3', position },
        { kind: 'update', blockId: 'A', layout: { align: 'center' } },
        { kind: 'update', blockId: 'B', layout: null },
      ],
    });
  });

  it('leaves a block that moves to another column as a plain move', () => {
    const position = { parentId: 'a2', previousId: null, nextId: null };
    expect(moveColumnIntent(model, 't1', position)).toMatchObject({
      kind: 'move',
    });
  });
});

describe('changing the layout', () => {
  it('merges what changed into what the item has and normalises the result', () => {
    expect(layoutIntent(model, 'A', { columns: '1:2:1' })).toEqual({
      kind: 'update',
      blockId: 'A',
      layout: { columns: '1:2:1', align: 'center' },
    });
    expect(layoutIntent(model, 'A', { columns: '1:1:1' })).toEqual({
      kind: 'update',
      blockId: 'A',
      layout: { align: 'center' },
    });
    expect(
      layoutIntent(model, 'A', { align: 'stretch', columns: undefined }),
    ).toEqual({
      kind: 'update',
      blockId: 'A',
      layout: null,
    });
  });

  it('turns fill on and off for a block', () => {
    const filled = modelWith({ t1: { fill: true } });
    expect(layoutIntent(filled, 't1', { fill: false })).toMatchObject({
      layout: null,
    });
    expect(layoutIntent(model, 't1', { fill: true })).toMatchObject({
      layout: { fill: true },
    });
  });

  it('is undone by restoring the layout it replaced', () => {
    const intent = layoutIntent(model, 'A', { columns: '1:2:1' });
    const entry = buildUndoEntry(intent, model, {
      kind: 'changed',
      itemId: 'A',
      property: 'Column widths',
    });
    expect(entry.inverse).toEqual({
      kind: 'update',
      blockId: 'A',
      layout: { columns: '2:1:1', align: 'center' },
    });
  });
});
