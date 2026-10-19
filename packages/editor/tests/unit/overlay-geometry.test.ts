import { describe, expect, it } from 'vitest';
import {
  chipPlacement,
  isMeasurable,
  sameBox,
  siblingAxis,
  toolbarPlacement,
} from '../../src/client/overlay/geometry.js';
import { chipText } from '../../src/client/overlay/overlay-layer.js';

// A 1070 by 850 frame scrolled down by 600: the part of the document it shows
// starts at (0, 600). Every box below is in the document's coordinates.
const VISIBLE = { left: 0, top: 600, width: 1070, height: 850 };

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
    const outline = { left: 96, top: 620, width: 200, height: 40 };
    expect(chipPlacement({ outline, visible: VISIBLE })).toEqual({
      mode: 'above',
      left: 96,
      top: 600,
    });
  });

  it('keeps the chip above for a 21px gap and moves it inside for a 19px gap', () => {
    const above = chipPlacement({
      outline: { left: 96, top: 621, width: 200, height: 40 },
      visible: VISIBLE,
    });
    expect(above.mode).toBe('above');
    const inside = chipPlacement({
      outline: { left: 96, top: 619, width: 200, height: 40 },
      visible: VISIBLE,
    });
    expect(inside).toEqual({ mode: 'inside', left: 100, top: 623 });
  });

  it('puts the chip 4px into the top-left corner when the outline is at the visible top', () => {
    const outline = { left: 37, top: 600, width: 300, height: 60 };
    expect(chipPlacement({ outline, visible: VISIBLE })).toEqual({
      mode: 'inside',
      left: 41,
      top: 604,
    });
  });

  it('makes the chip sticky, 4px below the visible top, once the element top has scrolled out', () => {
    const outline = { left: 37, top: 375, width: 300, height: 400 };
    expect(chipPlacement({ outline, visible: VISIBLE })).toEqual({
      mode: 'sticky',
      left: 41,
      top: 604,
    });
  });

  it('is sticky when only a sliver of the element is still visible', () => {
    const outline = { left: 37, top: 575, width: 300, height: 26 };
    expect(chipPlacement({ outline, visible: VISIBLE }).mode).toBe('sticky');
  });

  it('draws no chip for an element that is wholly above the visible part', () => {
    const outline = { left: 37, top: 375, width: 300, height: 100 };
    expect(chipPlacement({ outline, visible: VISIBLE }).mode).toBe('hidden');
    const touching = { left: 37, top: 500, width: 300, height: 100 };
    expect(chipPlacement({ outline: touching, visible: VISIBLE }).mode).toBe(
      'hidden',
    );
  });

  it('never starts the chip left of the visible part', () => {
    const wide = { left: -204, top: 875, width: 500, height: 40 };
    expect(chipPlacement({ outline: wide, visible: VISIBLE })).toMatchObject({
      mode: 'above',
      left: 0,
    });
    const scrolled = { left: -204, top: 575, width: 500, height: 400 };
    expect(
      chipPlacement({ outline: scrolled, visible: VISIBLE }),
    ).toMatchObject({ mode: 'sticky', left: 4 });
  });

  it('uses the chip height it is given', () => {
    const outline = { left: 96, top: 635, width: 200, height: 40 };
    expect(
      chipPlacement({ outline, visible: VISIBLE, chipHeight: 40 }).mode,
    ).toBe('inside');
    expect(
      chipPlacement({ outline, visible: VISIBLE, chipHeight: 20 }).mode,
    ).toBe('above');
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
        item: { left: 96, top: 875, width: 300, height: 100 },
        visible: VISIBLE,
        toolbar,
      }),
    ).toEqual({ mode: 'above', left: 96, top: 827 });
  });

  it('flips below when less than 48px of the visible part is above', () => {
    expect(
      toolbarPlacement({
        item: { left: 96, top: 635, width: 300, height: 100 },
        visible: VISIBLE,
        toolbar,
      }),
    ).toEqual({ mode: 'below', left: 96, top: 743 });
  });

  it('pins inside the visible top-left corner when neither side has room', () => {
    // taller than the frame and scrolled so its top is above the visible part
    expect(
      toolbarPlacement({
        item: { left: 96, top: 375, width: 300, height: 2000 },
        visible: VISIBLE,
        toolbar,
      }),
    ).toEqual({ mode: 'pinned', left: 104, top: 608 });
  });

  it('keeps the toolbar 8px inside the visible part at both edges', () => {
    const wide = { width: 400, height: 40 };
    expect(
      toolbarPlacement({
        item: { left: -204, top: 875, width: 50, height: 50 },
        visible: VISIBLE,
        toolbar: wide,
      }).left,
    ).toBe(8);
    expect(
      toolbarPlacement({
        item: { left: 996, top: 875, width: 50, height: 50 },
        visible: VISIBLE,
        toolbar: wide,
      }).left,
    ).toBe(1070 - 8 - 400);
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
