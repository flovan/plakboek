import { describe, expect, it } from 'vitest';
import {
  NO_SELECTION,
  breadcrumb,
  climb,
  drillByDoubleClick,
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
  it('selects the section first, at page scope', () => {
    expect(selectByClick(model, NO_SELECTION, chainOf('t1'))).toEqual({
      scopeId: null,
      selectedId: 's1',
    });
  });

  it('selects the scope child under the pointer after drilling', () => {
    // Scope is the column, so a click on another block of it selects that block.
    expect(selectByClick(model, at('t3'), chainOf('t4'))).toEqual(at('t4'));
    expect(selectByClick(model, at('t1'), chainOf('t2'))).toEqual(at('al'));
  });

  it('climbs as far as needed when the click lands in a different section', () => {
    expect(selectByClick(model, at('t2'), chainOf('t3'))).toEqual(at('s2'));
  });

  it('climbs one level when the click is outside the scope container but inside its parent', () => {
    expect(selectByClick(model, at('t3'), chainOf('c3'))).toEqual(at('s3'));
    expect(selectByClick(model, at('t3'), ['c2', 's2'])).toEqual(at('c2'));
  });

  it('clears on empty page area', () => {
    expect(selectByClick(model, at('t1'), [])).toEqual(NO_SELECTION);
  });

  it('selects the first item below a skipped level instead of nothing', () => {
    // The column has no box of its own, so only the block and section are hit.
    expect(selectByClick(model, at('c1'), ['t1', 's1'])).toEqual(at('t1'));
  });
});

describe('double-click', () => {
  it('drills section, then column, then block, and asks for Properties on a leaf', () => {
    let selection = selectByClick(model, NO_SELECTION, chainOf('t2'));
    expect(selection.selectedId).toBe('s1');

    let result = drillByDoubleClick(model, selection, chainOf('t2'));
    expect(result.selection).toEqual(at('c1'));
    expect(result.openProperties).toBe(false);

    selection = result.selection;
    result = drillByDoubleClick(model, selection, chainOf('t2'));
    expect(result.selection).toEqual(at('al'));

    result = drillByDoubleClick(model, result.selection, chainOf('t2'));
    expect(result.selection).toEqual(at('ai'));

    result = drillByDoubleClick(model, result.selection, chainOf('t2'));
    expect(result.selection).toEqual(at('t2'));
    expect(result.openProperties).toBe(false);

    result = drillByDoubleClick(model, result.selection, chainOf('t2'));
    expect(result.selection).toEqual(at('t2'));
    expect(result.openProperties).toBe(true);
  });

  it('selects the only column of a section even when the pointer is on the section itself', () => {
    const result = drillByDoubleClick(model, at('s1'), ['s1']);
    expect(result.selection).toEqual(at('c1'));
  });

  it('keeps a multi-column section selected when the pointer is on no column', () => {
    const result = drillByDoubleClick(model, at('s3'), ['s3']);
    expect(result.selection).toEqual(at('s3'));
    expect(result.openProperties).toBe(false);
  });

  it('does not ask for Properties on an empty column', () => {
    const result = drillByDoubleClick(model, at('c3'), chainOf('c3'));
    expect(result.selection).toEqual(at('c3'));
    expect(result.openProperties).toBe(false);
  });

  it('drills what the pointer is over when nothing was selected yet', () => {
    const result = drillByDoubleClick(model, NO_SELECTION, chainOf('t3'));
    expect(result.selection).toEqual(at('c2'));
  });

  it('does nothing on empty page area', () => {
    const result = drillByDoubleClick(model, at('t1'), []);
    expect(result.selection).toEqual(at('t1'));
    expect(result.openProperties).toBe(false);
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
    for (const [selection, id] of [
      [NO_SELECTION, 't1'],
      [at('t3'), 't4'],
      [at('t2'), 't3'],
    ] as const) {
      const chain = chainOf(id);
      expect(hoverTarget(model, selection, chain)).toBe(
        selectByClick(model, selection, chain).selectedId,
      );
    }
    expect(hoverTarget(model, at('t1'), [])).toBeNull();
  });
});
