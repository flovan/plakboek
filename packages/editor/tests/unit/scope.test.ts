import { describe, expect, it } from 'vitest';
import {
  NO_SELECTION,
  breadcrumb,
  climb,
  drillFirst,
  firstSibling,
  hoverTarget,
  lastSibling,
  nextSibling,
  previousSibling,
  selectByClick,
  selectCrumb,
  type Selection,
} from '../../src/client/session/scope.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

// s1 > c1 > [t1, al > ai > t2]; s2 > c2 > [t3, t4, t5]; s3 > [c3, c4]
const model = createTreeModel(
  buildNodes([
    section('s1', [
      column('c1', [
        block('t1', 'text'),
        block('al', 'accordionList', [
          block('ai', 'accordionItem', [block('t2', 'text')]),
        ]),
      ]),
    ]),
    section('s2', [
      column('c2', [
        block('t3', 'text'),
        block('t4', 'text'),
        block('t5', 'text'),
      ]),
    ]),
    section('s3', [column('c3'), column('c4')]),
  ]),
);

const chainOf = (id: string): string[] => [
  id,
  ...model.ancestorsOf(id).map((node) => node.id),
];
const at = (selectedId: string): Selection => ({
  scopeId: model.parentOf(selectedId)?.id ?? null,
  selectedId,
});

describe('click', () => {
  it('selects the deepest item under the pointer, whatever is selected', () => {
    expect(selectByClick(model, NO_SELECTION, chainOf('t1'))).toEqual(at('t1'));
    expect(selectByClick(model, at('s2'), chainOf('t2'))).toEqual(at('t2'));
    expect(selectByClick(model, at('t3'), chainOf('t4'))).toEqual(at('t4'));
  });

  it('selects the column on empty column space and the section on empty section space', () => {
    expect(selectByClick(model, at('t1'), ['c1', 's1'])).toEqual(at('c1'));
    expect(selectByClick(model, at('t1'), ['s1'])).toEqual(at('s1'));
    expect(selectByClick(model, NO_SELECTION, chainOf('c3'))).toEqual(at('c3'));
  });

  it('clears on empty page area', () => {
    expect(selectByClick(model, at('t1'), [])).toEqual(NO_SELECTION);
  });

  it('skips ids the model does not hold and selects the first one it does', () => {
    expect(selectByClick(model, NO_SELECTION, ['stale', 't1', 'c1'])).toEqual(
      at('t1'),
    );
    expect(selectByClick(model, at('t1'), ['stale'])).toEqual(NO_SELECTION);
  });

  it('keeps the selection when the selected item is clicked again', () => {
    const selection = at('t1');
    expect(selectByClick(model, selection, chainOf('t1'))).toBe(selection);
  });
});

describe('climb', () => {
  it('selects the parent with the grandparent as scope', () => {
    expect(climb(model, at('t1'))).toEqual(at('c1'));
    expect(climb(model, at('c1'))).toEqual(at('s1'));
  });

  it('clears at a top-level section', () => {
    expect(climb(model, at('s1'))).toEqual(NO_SELECTION);
    expect(climb(model, NO_SELECTION)).toEqual(NO_SELECTION);
  });
});

describe('breadcrumb', () => {
  it('lists the path outermost first and each crumb selects that ancestor', () => {
    expect(breadcrumb(model, 't2').map((node) => node.id)).toEqual([
      's1',
      'c1',
      'al',
      'ai',
      't2',
    ]);
    expect(selectCrumb(model, 'c1')).toEqual(at('c1'));
    expect(selectCrumb(model, 's1')).toEqual({
      scopeId: null,
      selectedId: 's1',
    });
  });
});

describe('keyboard navigation', () => {
  it('moves between siblings inside the scope and stops at the ends', () => {
    expect(nextSibling(model, at('t3'))).toEqual(at('t4'));
    expect(previousSibling(model, at('t4'))).toEqual(at('t3'));
    expect(nextSibling(model, at('t5'))).toEqual(at('t5'));
    expect(previousSibling(model, at('t3'))).toEqual(at('t3'));
    expect(firstSibling(model, at('t5'))).toEqual(at('t3'));
    expect(lastSibling(model, at('t3'))).toEqual(at('t5'));
  });

  it('starts at the scope edge when nothing is selected', () => {
    expect(nextSibling(model, NO_SELECTION)).toEqual(at('s1'));
    expect(previousSibling(model, NO_SELECTION)).toEqual(at('s3'));
  });

  it('drills to the first child and asks for Properties on a leaf', () => {
    expect(drillFirst(model, at('s2'))).toEqual({
      selection: at('c2'),
      openProperties: false,
    });
    expect(drillFirst(model, at('t1'))).toEqual({
      selection: at('t1'),
      openProperties: true,
    });
    expect(drillFirst(model, at('c3'))).toEqual({
      selection: at('c3'),
      openProperties: false,
    });
  });
});

describe('hover', () => {
  it('previews exactly what a click would select', () => {
    for (const id of ['t1', 't4', 'c3', 's1']) {
      const chain = chainOf(id);
      expect(hoverTarget(model, chain)).toBe(
        selectByClick(model, NO_SELECTION, chain).selectedId,
      );
    }
    expect(hoverTarget(model, ['c1', 's1'])).toBe('c1');
    expect(hoverTarget(model, ['stale', 't1'])).toBe('t1');
    expect(hoverTarget(model, [])).toBeNull();
  });
});
