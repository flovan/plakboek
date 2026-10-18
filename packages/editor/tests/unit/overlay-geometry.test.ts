import { describe, expect, it } from 'vitest';
import {
  chipPlacement,
  isMeasurable,
  outlineRect,
  sameBox,
  siblingAxis,
  toolbarPlacement,
} from '../../src/client/overlay/geometry.js';
import { chipText } from '../../src/client/overlay/overlay-layer.js';

// A frame whose content box starts at (304, 25) in the shell and is 1070 by
// 850 pixels.
const FRAME = { left: 304, top: 25, width: 1070, height: 850 };

describe('outlineRect', () => {
  it('moves the element box by where the frame content starts', () => {
    expect(
      outlineRect(
        { left: 37, top: 120.5, width: 400, height: 28 },
        { x: 304, y: 25 },
      ),
    ).toEqual({ left: 341, top: 145.5, width: 400, height: 28 });
  });

  it('keeps the size and leaves the box alone for a zero origin', () => {
    const box = { left: 5, top: 6, width: 7, height: 8 };
    expect(outlineRect(box, { x: 0, y: 0 })).toEqual(box);
  });

  it('follows a frame that sits somewhere else, such as the full-width layout', () => {
    const box = { left: 10, top: 10, width: 50, height: 20 };
    expect(outlineRect(box, { x: 56, y: 0 })).toEqual({
      left: 66,
      top: 10,
      width: 50,
      height: 20,
    });
  });
});

describe('isMeasurable', () => {
  it('accepts a box with a size', () => {
    expect(isMeasurable({ width: 10, height: 10 }, 'block')).toBe(true);
  });

  it('refuses a zero width or a zero height', () => {
    expect(isMeasurable({ width: 0, height: 10 }, 'block')).toBe(false);
    expect(isMeasurable({ width: 10, height: 0 }, 'block')).toBe(false);
  });

  it('refuses display: contents, whatever size it reports', () => {
    expect(isMeasurable({ width: 10, height: 10 }, 'contents')).toBe(false);
  });
});

describe('chipPlacement', () => {
  it('rests the chip on the outline top when there are 20px of room above', () => {
    const outline = { left: 400, top: 45, width: 200, height: 40 };
    expect(chipPlacement({ outline, frame: FRAME })).toEqual({
      mode: 'above',
      left: 400,
      top: 25,
    });
  });

  it('keeps the chip above for a 21px gap and moves it inside for a 19px gap', () => {
    const above = chipPlacement({
      outline: { left: 400, top: 46, width: 200, height: 40 },
      frame: FRAME,
    });
    expect(above.mode).toBe('above');
    const inside = chipPlacement({
      outline: { left: 400, top: 44, width: 200, height: 40 },
      frame: FRAME,
    });
    expect(inside).toEqual({ mode: 'inside', left: 404, top: 48 });
  });

  it('puts the chip 4px into the top-left corner when the outline is at the frame top', () => {
    const outline = { left: 341, top: 25, width: 300, height: 60 };
    expect(chipPlacement({ outline, frame: FRAME })).toEqual({
      mode: 'inside',
      left: 345,
      top: 29,
    });
  });

  it('pins the chip 4px below the frame top once the element top has scrolled out', () => {
    const outline = { left: 341, top: -200, width: 300, height: 400 };
    expect(chipPlacement({ outline, frame: FRAME })).toEqual({
      mode: 'pinned',
      left: 345,
      top: 29,
    });
  });

  it('pins when only a sliver of the element is still visible', () => {
    const outline = { left: 341, top: 0, width: 300, height: 26 };
    expect(chipPlacement({ outline, frame: FRAME }).mode).toBe('pinned');
  });

  it('draws no chip for an element that is wholly above the frame', () => {
    const outline = { left: 341, top: -200, width: 300, height: 100 };
    expect(chipPlacement({ outline, frame: FRAME }).mode).toBe('hidden');
    const touching = { left: 341, top: -75, width: 300, height: 100 };
    expect(chipPlacement({ outline: touching, frame: FRAME }).mode).toBe(
      'hidden',
    );
  });

  it('never starts the chip left of the frame', () => {
    const wide = { left: 100, top: 300, width: 500, height: 40 };
    expect(chipPlacement({ outline: wide, frame: FRAME })).toMatchObject({
      mode: 'above',
      left: 304,
    });
    const scrolled = { left: 100, top: 0, width: 500, height: 400 };
    expect(chipPlacement({ outline: scrolled, frame: FRAME })).toMatchObject({
      mode: 'pinned',
      left: 308,
    });
  });

  it('uses the chip height it is given', () => {
    const outline = { left: 400, top: 60, width: 200, height: 40 };
    expect(chipPlacement({ outline, frame: FRAME, chipHeight: 40 }).mode).toBe(
      'inside',
    );
    expect(chipPlacement({ outline, frame: FRAME, chipHeight: 20 }).mode).toBe(
      'above',
    );
  });
});

describe('sameBox', () => {
  it('compares every side, and treats two nulls as the same', () => {
    const box = { left: 1, top: 2, width: 3, height: 4 };
    expect(sameBox(box, { ...box })).toBe(true);
    expect(sameBox(box, { ...box, height: 5 })).toBe(false);
    expect(sameBox(null, null)).toBe(true);
    expect(sameBox(box, null)).toBe(false);
  });
});

describe('chipText', () => {
  it('shows the label as it is', () => {
    expect(chipText({ label: 'Heading', unavailable: false })).toBe('Heading');
  });

  it('adds the unavailable suffix to the stored type key', () => {
    expect(chipText({ label: 'retired-widget', unavailable: true })).toBe(
      'retired-widget (unavailable)',
    );
  });
});

describe('toolbarPlacement', () => {
  const toolbar = { width: 200, height: 40 };

  it('sits 8px above the item with its left edge aligned', () => {
    expect(
      toolbarPlacement({
        item: { left: 400, top: 300, width: 300, height: 100 },
        frame: FRAME,
        toolbar,
      }),
    ).toEqual({ mode: 'above', left: 400, top: 252 });
  });

  it('flips below when less than 48px of frame room is above', () => {
    expect(
      toolbarPlacement({
        item: { left: 400, top: 60, width: 300, height: 100 },
        frame: FRAME,
        toolbar,
      }),
    ).toEqual({ mode: 'below', left: 400, top: 168 });
  });

  it('pins inside the visible top-left corner when neither side has room', () => {
    // taller than the frame and scrolled so its top is above the frame
    expect(
      toolbarPlacement({
        item: { left: 400, top: -200, width: 300, height: 2000 },
        frame: FRAME,
        toolbar,
      }),
    ).toEqual({ mode: 'pinned', left: 408, top: 33 });
  });

  it('keeps the toolbar 8px inside the frame at both edges', () => {
    const wide = { width: 400, height: 40 };
    expect(
      toolbarPlacement({
        item: { left: 100, top: 300, width: 50, height: 50 },
        frame: FRAME,
        toolbar: wide,
      }).left,
    ).toBe(312);
    expect(
      toolbarPlacement({
        item: { left: 1300, top: 300, width: 50, height: 50 },
        frame: FRAME,
        toolbar: wide,
      }).left,
    ).toBe(304 + 1070 - 8 - 400);
  });
});

describe('siblingAxis', () => {
  it('is horizontal when the left edges differ more than the top edges', () => {
    expect(
      siblingAxis([
        { left: 0, top: 10, width: 100, height: 50 },
        { left: 120, top: 12, width: 100, height: 50 },
      ]),
    ).toBe('horizontal');
  });

  it('is vertical for a stack, and for fewer than two siblings', () => {
    expect(
      siblingAxis([
        { left: 0, top: 0, width: 100, height: 50 },
        { left: 2, top: 60, width: 100, height: 50 },
      ]),
    ).toBe('vertical');
    expect(siblingAxis([{ left: 0, top: 0, width: 1, height: 1 }])).toBe(
      'vertical',
    );
  });
});
