import { describe, expect, it } from 'vitest';
import type { CatalogueEntry, ModelNode } from '../../src/api-types.js';
import {
  keyMove,
  treeRows,
  type TreeRow,
} from '../../src/client/session/page-tree.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import {
  block,
  buildNodes,
  catalogueEntry,
  column,
  section,
} from './support/model.js';

const catalogue = new Map<string, CatalogueEntry>(
  [
    catalogueEntry('section', 'section'),
    catalogueEntry('column', 'column'),
    catalogueEntry('heading', 'block'),
    catalogueEntry('text', 'block'),
    catalogueEntry('accordionList', 'block'),
    catalogueEntry('accordionItem', 'block'),
  ].map((entry) => [entry.key, entry]),
);

const nodes = buildNodes([
  section('s1', [
    column('c1', [
      block('h1', 'heading'),
      block('al', 'accordionList', [block('ai', 'accordionItem')]),
    ]),
    column('c2', [block('t2', 'text')]),
  ]),
  section('s2', [column('c3')]),
]);

function rowsWith(
  collapsed: readonly string[] = [],
  changes: Readonly<Record<string, Partial<ModelNode>>> = {},
): readonly TreeRow[] {
  const changed = nodes.map((node) => ({ ...node, ...changes[node.id] }));
  return treeRows(createTreeModel(changed), catalogue, new Set(collapsed));
}

const ids = (rows: readonly TreeRow[]): string[] => rows.map((row) => row.id);

describe('treeRows', () => {
  it('lists sections at level 1, columns at 2 and blocks at 3, in page order, with their place among siblings', () => {
    const rows = rowsWith();
    expect(ids(rows)).toEqual([
      's1',
      'c1',
      'h1',
      'al',
      'ai',
      'c2',
      't2',
      's2',
      'c3',
    ]);
    expect(rows.map((row) => row.level)).toEqual([1, 2, 3, 3, 4, 2, 3, 1, 2]);
    const al = rows.find((row) => row.id === 'al');
    expect(al).toMatchObject({ posInSet: 2, setSize: 2, parentId: 'c1' });
    const s2 = rows.find((row) => row.id === 's2');
    expect(s2).toMatchObject({ posInSet: 2, setSize: 2, parentId: null });
  });

  it('hides everything under a collapsed id and reports it as not expanded', () => {
    const rows = rowsWith(['c1']);
    expect(ids(rows)).toEqual(['s1', 'c1', 'c2', 't2', 's2', 'c3']);
    expect(rows.find((row) => row.id === 'c1')).toMatchObject({
      hasChildren: true,
      expanded: false,
    });
    expect(rows.find((row) => row.id === 'h1')).toBeUndefined();
    // a leaf is never expanded, collapsed or not
    expect(rowsWith().find((row) => row.id === 'c3')).toMatchObject({
      hasChildren: false,
      expanded: false,
    });
  });

  it('numbers columns, follows needsInput and labels a degraded or unknown type as unavailable', () => {
    const rows = rowsWith([], {
      h1: { needsInput: ['text'] },
      t2: { unavailable: 'degraded' },
      ai: { type: 'retired-widget', unavailable: 'unknown' },
    });
    const label = (id: string) => rows.find((row) => row.id === id)?.label;
    expect(label('c2')).toBe('Column 2');
    expect(label('h1')).toBe('heading');
    expect(label('t2')).toBe('text (unavailable)');
    expect(label('ai')).toBe('retired-widget (unavailable)');
    expect(rows.find((row) => row.id === 'h1')?.needsInput).toBe(true);
    expect(rows.find((row) => row.id === 't2')?.needsInput).toBe(false);
  });

  it('labels a type missing from the catalogue as unavailable even when the model does not say so', () => {
    const model = createTreeModel(nodes);
    const rows = treeRows(model, new Map(), new Set());
    expect(rows.find((row) => row.id === 'h1')?.label).toBe(
      'heading (unavailable)',
    );
    expect(rows.find((row) => row.id === 'c1')?.label).toBe('Column 1');
  });
});

describe('keyMove', () => {
  const rows = rowsWith(['c2']);

  it('moves to the next and previous visible row, and stops at the ends', () => {
    expect(keyMove(rows, 'h1', 'ArrowDown')).toEqual({
      action: 'focus',
      id: 'al',
    });
    expect(keyMove(rows, 'c2', 'ArrowDown')).toEqual({
      action: 'focus',
      id: 's2',
    });
    expect(keyMove(rows, 'al', 'ArrowUp')).toEqual({
      action: 'focus',
      id: 'h1',
    });
    expect(keyMove(rows, 's1', 'ArrowUp')).toBeNull();
    expect(keyMove(rows, 'c3', 'ArrowDown')).toBeNull();
  });

  it('jumps to the first and last visible row with Home and End', () => {
    expect(keyMove(rows, 'al', 'Home')).toEqual({ action: 'focus', id: 's1' });
    expect(keyMove(rows, 'al', 'End')).toEqual({ action: 'focus', id: 'c3' });
  });

  it('expands a collapsed row with Right and moves into an expanded one', () => {
    expect(keyMove(rows, 'c2', 'ArrowRight')).toEqual({ action: 'expand' });
    expect(keyMove(rows, 's1', 'ArrowRight')).toEqual({
      action: 'focus',
      id: 'c1',
    });
    expect(keyMove(rows, 'h1', 'ArrowRight')).toBeNull();
  });

  it('collapses an expanded row with Left and otherwise moves to the parent row', () => {
    expect(keyMove(rows, 's1', 'ArrowLeft')).toEqual({ action: 'collapse' });
    expect(keyMove(rows, 'h1', 'ArrowLeft')).toEqual({
      action: 'focus',
      id: 'c1',
    });
    expect(keyMove(rows, 'c2', 'ArrowLeft')).toEqual({
      action: 'focus',
      id: 's1',
    });
    expect(keyMove(rows, 's2', 'ArrowLeft')).toBeNull();
  });
});
