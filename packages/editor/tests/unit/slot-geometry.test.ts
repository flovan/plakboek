import { describe, expect, it } from 'vitest';
import type { Box } from '../../src/client/overlay/geometry.js';
import {
  pickerPlacement,
  slotGeometry,
} from '../../src/client/overlay/slot-geometry.js';
import type { InsertSlot } from '../../src/client/session/insertion.js';

const boxes = new Map<string, Box>([
  ['col', { left: 100, top: 0, width: 400, height: 500 }],
  ['a', { left: 100, top: 40, width: 400, height: 100 }],
  ['b', { left: 100, top: 160, width: 400, height: 100 }],
]);

function slot(previousId: string | null, nextId: string | null): InsertSlot {
  return { parentId: 'col', previousId, nextId, level: 'block' };
}

describe('the band over a gap', () => {
  it('sits in the middle of the gap between two stacked siblings, as wide as the parent', () => {
    expect(slotGeometry(slot('a', 'b'), boxes)).toEqual({
      band: { left: 100, top: 142, width: 400, height: 16 },
      line: 'across',
      center: { x: 300, y: 150 },
    });
  });

  it('sits on the edge above the first and below the last', () => {
    expect(slotGeometry(slot(null, 'a'), boxes)?.center.y).toBe(40);
    expect(slotGeometry(slot('b', null), boxes)?.center.y).toBe(260);
  });

  it('has no band when a neighbour has no box, or there is none', () => {
    expect(slotGeometry(slot('a', 'gone'), boxes)).toBeNull();
    expect(slotGeometry(slot(null, null), boxes)).toBeNull();
  });
});

describe('the picker placement', () => {
  const frame: Box = { left: 0, top: 0, width: 800, height: 600 };

  it('hangs below its anchor when there is room, kept inside the frame', () => {
    const placed = pickerPlacement(
      { left: 10, top: 100, width: 24, height: 24 },
      frame,
    );
    expect(placed.side).toBe('below');
    expect(placed.left).toBe(8);
    expect(placed.top).toBe(132);
    expect(placed.maxHeight).toBe(360);
  });

  it('flips above its anchor near the bottom of the frame and never outgrows the frame', () => {
    const placed = pickerPlacement(
      { left: 400, top: 340, width: 24, height: 24 },
      { ...frame, height: 400 },
    );
    expect(placed.side).toBe('above');
    expect(placed.maxHeight).toBe(324);
  });
});
