import { describe, expect, it, vi } from 'vitest';
import type { DragScene } from '../../src/client/drag/scene.js';
import { createKeyboardDrag } from '../../src/client/drag/keyboard.js';
import type { KeyboardSlot } from '../../src/client/drag/slots.js';
import type { Box } from '../../src/client/overlay/geometry.js';
import type { LegalityContext } from '../../src/client/session/legality.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import {
  block,
  buildNodes,
  catalogueEntry,
  column,
  section,
} from './support/model.js';

const entries = [
  catalogueEntry('section', 'section'),
  catalogueEntry('column', 'column'),
  catalogueEntry('text', 'block'),
];

// A: ca1 [t1, t2], ca2 [t3]   B: cb [t4]
const ctx: LegalityContext = {
  catalogue: new Map(entries.map((entry) => [entry.key, entry])),
  model: createTreeModel(
    buildNodes([
      section('A', [
        column('ca1', [block('t1', 'text'), block('t2', 'text')]),
        column('ca2', [block('t3', 'text')]),
      ]),
      section('B', [column('cb', [block('t4', 'text')])]),
    ]),
  ),
  limits: { sectionNestingDepth: 2, blockDepthCeiling: 12 },
  columnsEnabled: true,
};

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

const scene: DragScene = {
  model: ctx.model,
  frame: box(0, 0, 600, 600),
  rects: new Map([
    ['A', box(0, 0, 600, 200)],
    ['ca1', box(0, 0, 300, 200)],
    ['t1', box(0, 0, 300, 40)],
    ['t2', box(0, 60, 300, 40)],
    ['ca2', box(300, 0, 300, 200)],
    ['t3', box(300, 0, 300, 40)],
    ['B', box(0, 220, 600, 100)],
    ['cb', box(0, 220, 600, 100)],
    ['t4', box(0, 220, 600, 40)],
  ]),
};

/** A drag of `t2`, with everything it reports recorded. */
function lifted() {
  const said: string[] = [];
  const slots: (KeyboardSlot | null)[] = [];
  const dropped = vi.fn();
  const ended = vi.fn();
  const drag = createKeyboardDrag({
    subject: { kind: 'move', id: 't2' },
    label: 'Text',
    ctx: () => ctx,
    sceneOf: () => scene,
    announce: (text) => said.push(text),
    onSlot: (slot) => slots.push(slot),
    reveal: () => undefined,
    onDrop: dropped,
    onEnd: ended,
  });
  return { drag, said, slots, dropped, ended };
}

describe('lifting', () => {
  it('announces the pick-up and starts at the slot the item holds now', () => {
    const { drag, said, slots } = lifted();
    expect(drag.lift()).toBe(true);
    expect(said).toEqual([
      'Picked up Text. Use the arrow keys to choose a position, Space to drop, Escape to cancel.',
    ]);
    expect(slots.at(-1)?.position).toEqual({
      parentId: 'ca1',
      previousId: 't1',
      nextId: null,
    });
  });
});

describe('stepping', () => {
  it('walks the slots in document order and announces each one', () => {
    const { drag, said, slots } = lifted();
    drag.lift();
    drag.step('down');
    expect(said.at(-1)).toBe('Position 1 of 2 in Column 2.');
    expect(slots.at(-1)?.position).toEqual({
      parentId: 'ca2',
      previousId: null,
      nextId: 't3',
    });
    drag.step('up');
    expect(said.at(-1)).toBe('Position 2 of 2 in Column 1.');
  });

  it('says nothing at the end of the list', () => {
    const { drag, said } = lifted();
    drag.lift();
    for (let step = 0; step < 8; step += 1) drag.step('down');
    const last = said.length;
    drag.step('down');
    expect(said).toHaveLength(last);
  });

  it('jumps to the next column at the same height with Right and back with Left', () => {
    const { drag, slots } = lifted();
    drag.lift();
    drag.step('right');
    expect(slots.at(-1)?.position).toEqual({
      parentId: 'ca2',
      previousId: 't3',
      nextId: null,
    });
    drag.step('left');
    expect(slots.at(-1)?.position).toEqual({
      parentId: 'ca1',
      previousId: 't1',
      nextId: null,
    });
  });

  it('stays put across when there is no column on that side', () => {
    const { drag, said } = lifted();
    drag.lift();
    drag.step('left');
    expect(said).toHaveLength(1);
  });
});

describe('dropping and cancelling', () => {
  it('drops at the chosen slot, announces it and ends', () => {
    const { drag, said, dropped, ended, slots } = lifted();
    drag.lift();
    drag.step('down');
    drag.step('down');
    drag.drop();
    expect(said.at(-1)).toBe('Dropped Text at position 2 of 2 in Column 2.');
    expect(dropped).toHaveBeenCalledWith({
      parentId: 'ca2',
      previousId: 't3',
      nextId: null,
    });
    expect(ended).toHaveBeenCalledOnce();
    expect(slots.at(-1)).toBeNull();
    expect(drag.lifted).toBe(false);
  });

  it('cancels with no drop', () => {
    const { drag, said, dropped, ended } = lifted();
    drag.lift();
    drag.step('down');
    drag.cancel();
    expect(said.at(-1)).toBe('Move cancelled.');
    expect(dropped).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledOnce();
  });
});
