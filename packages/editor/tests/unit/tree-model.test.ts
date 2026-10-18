import { describe, expect, it } from 'vitest';
import type { CatalogueEntry } from '../../src/api-types.js';
import {
  createTreeModel,
  labelOf,
} from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

const nodes = buildNodes([
  section('s1', [
    column('c1', [
      block('t1', 'text'),
      block('al', 'accordionList', [block('ai', 'accordionItem')]),
    ]),
    column('c2', [block('t2', 'mystery')]),
  ]),
  section('s2', [column('c3')]),
]);

describe('createTreeModel', () => {
  it('orders children by sort order and then by id, whatever the payload order', () => {
    const shuffled = [...nodes]
      .reverse()
      .map((node) =>
        node.id === 'c1'
          ? { ...node, sortOrder: 5 }
          : node.id === 'c2'
            ? { ...node, sortOrder: 5 }
            : node,
      );
    const model = createTreeModel(shuffled);
    expect(model.childrenOf('s1').map((node) => node.id)).toEqual(['c1', 'c2']);
    expect(model.roots().map((node) => node.id)).toEqual(['s1', 's2']);
  });

  it('lists the document depth first, parents before children', () => {
    const model = createTreeModel(nodes);
    expect(model.documentOrder().map((node) => node.id)).toEqual([
      's1',
      'c1',
      't1',
      'al',
      'ai',
      'c2',
      't2',
      's2',
      'c3',
    ]);
  });

  it('finds the parent and the ancestors nearest first', () => {
    const model = createTreeModel(nodes);
    expect(model.parentOf('ai')?.id).toBe('al');
    expect(model.parentOf('s1')).toBeNull();
    expect(model.ancestorsOf('ai').map((node) => node.id)).toEqual([
      'al',
      'c1',
      's1',
    ]);
    expect(model.ancestorsOf('s2')).toEqual([]);
  });

  it('lists a subtree with the item included', () => {
    const model = createTreeModel(nodes);
    expect(model.subtreeIds('c1')).toEqual(['c1', 't1', 'al', 'ai']);
    expect(model.subtreeIds('t1')).toEqual(['t1']);
    expect(model.subtreeIds('missing')).toEqual([]);
  });

  it('reports the sibling position and count', () => {
    const model = createTreeModel(nodes);
    expect(model.siblingIndex('c2')).toEqual({ index: 1, total: 2 });
    expect(model.siblingIndex('s1')).toEqual({ index: 0, total: 2 });
    expect(model.siblingIndex('missing')).toBeNull();
  });
});

describe('labelOf', () => {
  const entry = (key: string, label: string): CatalogueEntry => ({
    key,
    kind: 'block',
    editor: { label },
    placement: {
      ownerTypes: ['page'],
      allowedParents: 'any',
      allowedChildren: 'any',
    },
    supportsFill: false,
    starterChildren: [],
    properties: [],
  });
  const catalogue = new Map([['text', entry('text', 'Text')]]);

  it('uses the editor label, numbers a column and falls back to the type key', () => {
    const model = createTreeModel(nodes);
    expect(labelOf(model, catalogue, 't1')).toEqual({
      kind: 'text',
      text: 'Text',
    });
    expect(labelOf(model, catalogue, 'c2')).toEqual({ kind: 'column', n: 2 });
    expect(labelOf(model, catalogue, 't2')).toEqual({
      kind: 'text',
      text: 'mystery',
    });
  });
});
