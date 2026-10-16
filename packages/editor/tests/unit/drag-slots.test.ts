import { describe, expect, it } from 'vitest';
import type { Box } from '../../src/client/overlay/geometry.js';
import type { DragScene } from '../../src/client/drag/scene.js';
import { keyboardSlots, resolveDropSlot } from '../../src/client/drag/slots.js';
import { autoScrollStep } from '../../src/client/drag/controller.js';
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

const entries = [
  catalogueEntry('section', 'section'),
  catalogueEntry('column', 'column'),
  catalogueEntry('text', 'block'),
];

function contextFor(
  roots: readonly Spec[],
  sectionNestingDepth = 2,
): LegalityContext {
  return {
    catalogue: new Map(entries.map((entry) => [entry.key, entry])),
    model: createTreeModel(buildNodes(roots)),
    limits: { sectionNestingDepth, blockDepthCeiling: 12 },
    columnsEnabled: true,
  };
}

const box = (
  left: number,
  top: number,
  width: number,
  height: number,
): Box => ({
  left,
  top,
  width,
  height,
});

function sceneFor(
  ctx: LegalityContext,
  rects: Readonly<Record<string, Box>>,
): DragScene {
  return {
    model: ctx.model,
    rects: new Map(Object.entries(rects)),
    frame: box(0, 0, 600, 600),
  };
}

// A: ca1 [t1, t2], ca2 [t3]   B: cb [t4]
const tree = [
  section('A', [
    column('ca1', [block('t1', 'text'), block('t2', 'text')]),
    column('ca2', [block('t3', 'text')]),
  ]),
  section('B', [column('cb', [block('t4', 'text')])]),
];
const rects = {
  A: box(0, 0, 600, 200),
  ca1: box(0, 0, 300, 200),
  t1: box(0, 0, 300, 40),
  t2: box(0, 60, 300, 40),
  ca2: box(300, 0, 300, 200),
  t3: box(300, 0, 300, 40),
  B: box(0, 220, 600, 100),
  cb: box(0, 220, 600, 100),
  t4: box(0, 220, 600, 40),
};

describe('the slot under the pointer', () => {
  const ctx = contextFor(tree);
  const scene = sceneFor(ctx, rects);

  it('takes its index from the middles of the siblings and draws a line across the gap', () => {
    const between = resolveDropSlot(
      ctx,
      scene,
      { kind: 'move', id: 't3' },
      { x: 100, y: 50 },
      ['t1', 'ca1', 'A'],
    );
    expect(between).toEqual({
      position: { parentId: 'ca1', previousId: 't1', nextId: 't2' },
      line: box(0, 49, 300, 2),
      axis: 'horizontal',
    });

    const first = resolveDropSlot(
      ctx,
      scene,
      { kind: 'move', id: 't3' },
      { x: 100, y: 5 },
      ['t1', 'ca1', 'A'],
    );
    expect(first?.position).toEqual({
      parentId: 'ca1',
      previousId: null,
      nextId: 't1',
    });

    const last = resolveDropSlot(
      ctx,
      scene,
      { kind: 'move', id: 't3' },
      { x: 100, y: 150 },
      ['ca1', 'A'],
    );
    expect(last).toEqual({
      position: { parentId: 'ca1', previousId: 't2', nextId: null },
      line: box(0, 99, 300, 2),
      axis: 'horizontal',
    });
  });

  it('draws a vertical line between columns', () => {
    const slot = resolveDropSlot(
      ctx,
      scene,
      { kind: 'move', id: 'ca2' },
      { x: 450, y: 100 },
      ['ca2', 'A'],
    );
    expect(slot).toEqual({
      position: { parentId: 'A', previousId: 'ca1', nextId: null },
      line: box(299, 0, 2, 200),
      axis: 'vertical',
    });
  });

  it('passes over a container that refuses the item for the next one out, up to the page', () => {
    const flat = contextFor(tree, 1);
    const slot = resolveDropSlot(
      flat,
      sceneFor(flat, rects),
      { kind: 'move', id: 'B' },
      { x: 100, y: 50 },
      ['t1', 'ca1', 'A'],
    );
    expect(slot?.position).toEqual({
      parentId: null,
      previousId: null,
      nextId: 'A',
    });
    expect(slot?.axis).toBe('horizontal');
  });

  it('finds no slot where nothing may land', () => {
    expect(
      resolveDropSlot(
        ctx,
        scene,
        { kind: 'move', id: 't1' },
        { x: 5, y: 500 },
        [],
      ),
    ).toBeNull();
  });

  it('never lands inside the moved item', () => {
    const slot = resolveDropSlot(
      ctx,
      scene,
      { kind: 'move', id: 'A' },
      { x: 100, y: 300 },
      ['t1', 'ca1', 'A'],
    );
    expect(slot?.position.parentId).toBeNull();
    expect(slot?.position).toEqual({
      parentId: null,
      previousId: 'B',
      nextId: null,
    });
  });

  it('keeps the model order of siblings the site draws at no size', () => {
    const hidden = contextFor([
      section('A', [
        column('ca1', [
          block('t1', 'text'),
          block('h', 'text'),
          block('t2', 'text'),
        ]),
        column('ca2', [block('t3', 'text')]),
      ]),
    ]);
    // `h` has no box in the scene at all: the site draws it at no size.
    const slot = resolveDropSlot(
      hidden,
      sceneFor(hidden, rects),
      { kind: 'move', id: 't3' },
      { x: 100, y: 50 },
      ['ca1', 'A'],
    );
    expect(slot).toEqual({
      position: { parentId: 'ca1', previousId: 'h', nextId: 't2' },
      line: box(0, 49, 300, 2),
      axis: 'horizontal',
    });
  });

  it('gives a block over the padding of a section the column nearest to the pointer', () => {
    const slot = resolveDropSlot(
      ctx,
      scene,
      { kind: 'move', id: 't1' },
      { x: 590, y: 190 },
      ['A'],
    );
    expect(slot?.position.parentId).toBe('ca2');
  });
});

describe('the slots the keyboard steps through', () => {
  it('lists every legal gap in document order with where the item would sit', () => {
    const ctx = contextFor(tree);
    const slots = keyboardSlots(ctx, sceneFor(ctx, rects), {
      kind: 'move',
      id: 't3',
    });
    expect(
      slots.map((slot) => [
        slot.parentId,
        slot.position.previousId,
        slot.position.nextId,
        slot.index + 1,
        slot.total,
        slot.parentLabel,
      ]),
    ).toEqual([
      ['ca1', null, 't1', 1, 3, 'Column 1'],
      ['ca1', 't1', 't2', 2, 3, 'Column 1'],
      ['ca1', 't2', null, 3, 3, 'Column 1'],
      ['ca2', null, null, 1, 1, 'Column 2'],
      ['cb', null, 't4', 1, 2, 'Column 1'],
      ['cb', 't4', null, 2, 2, 'Column 1'],
    ]);
  });

  it('offers the page for a section and leaves the line out where the site draws nothing', () => {
    const ctx = contextFor(tree, 1);
    const slots = keyboardSlots(ctx, sceneFor(ctx, {}), {
      kind: 'move',
      id: 'B',
    });
    expect(
      slots.map((slot) => [slot.parentLabel, slot.index, slot.line]),
    ).toEqual([
      ['Page', 0, null],
      ['Page', 1, null],
    ]);
  });
});

describe('the frame auto-scroll', () => {
  it('scrolls faster nearer the edge, up to 16px, and not at all away from it', () => {
    expect(autoScrollStep(300, 600)).toBe(0);
    expect(autoScrollStep(0, 600)).toBe(-16);
    expect(autoScrollStep(-10, 600)).toBe(-16);
    expect(autoScrollStep(24, 600)).toBe(-8);
    expect(autoScrollStep(600, 600)).toBe(16);
    expect(autoScrollStep(576, 600)).toBe(8);
  });
});
