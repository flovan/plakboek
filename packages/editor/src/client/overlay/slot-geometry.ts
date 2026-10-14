/**
 * Where a gap between siblings sits on screen, as pure functions over boxes in
 * one coordinate space: the 16px band that takes the pointer, which way the
 * line across it runs, and the point the add button and the picker are
 * anchored to.
 */
import type { InsertSlot } from '../session/insertion.js';
import { siblingAxis, type Box, type Point } from './geometry.js';

/** How thick the band over a gap is. */
export const BAND_THICKNESS = 16;

/** The button's visible size, and its hit area. */
export const ADD_BUTTON_SIZE = 24;
export const ADD_BUTTON_HIT = 32;

export type SlotGeometry = {
  /** The band over the gap that takes the pointer. */
  readonly band: Box;
  /** `across` runs left to right, between stacked siblings; `down` runs top to bottom, between side by side ones. */
  readonly line: 'across' | 'down';
  /** The middle of the gap, where the button sits. */
  readonly center: Point;
};

function union(boxes: readonly Box[]): Box | null {
  const first = boxes[0];
  if (first === undefined) return null;
  let left = first.left;
  let top = first.top;
  let right = first.left + first.width;
  let bottom = first.top + first.height;
  for (const box of boxes) {
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The band, line and centre of a gap. `boxes` holds the boxes of the
 * neighbours and, when it has one, of the parent that gives the line its
 * length. A gap with no neighbour (an empty parent) has no band: the prompt
 * for an empty container stands in for it. `axisOf` says which way the
 * siblings run when the caller knows it better than the neighbours can show.
 */
export function slotGeometry(
  slot: InsertSlot,
  boxes: ReadonlyMap<string, Box>,
  axisOf?: 'horizontal' | 'vertical',
): SlotGeometry | null {
  const previous =
    slot.previousId === null ? null : (boxes.get(slot.previousId) ?? null);
  const next = slot.nextId === null ? null : (boxes.get(slot.nextId) ?? null);
  if (slot.previousId !== null && previous === null) return null;
  if (slot.nextId !== null && next === null) return null;
  const neighbours = [previous, next].filter((box): box is Box => box !== null);
  if (neighbours.length === 0) return null;

  const parent =
    slot.parentId === null ? null : (boxes.get(slot.parentId) ?? null);
  const extent = parent ?? union(neighbours);
  if (extent === null) return null;
  // The neighbours of a gap after the last item cannot tell which way their siblings run.
  const axis = axisOf ?? siblingAxis(neighbours);

  if (axis === 'vertical') {
    const y =
      previous !== null && next !== null
        ? (previous.top + previous.height + next.top) / 2
        : previous !== null
          ? previous.top + previous.height
          : (next?.top ?? 0);
    return {
      band: {
        left: extent.left,
        top: y - BAND_THICKNESS / 2,
        width: extent.width,
        height: BAND_THICKNESS,
      },
      line: 'across',
      center: { x: extent.left + extent.width / 2, y },
    };
  }
  const x =
    previous !== null && next !== null
      ? (previous.left + previous.width + next.left) / 2
      : previous !== null
        ? previous.left + previous.width
        : (next?.left ?? 0);
  return {
    band: {
      left: x - BAND_THICKNESS / 2,
      top: extent.top,
      width: BAND_THICKNESS,
      height: extent.height,
    },
    line: 'down',
    center: { x, y: extent.top + extent.height / 2 },
  };
}

/**
 * What the picker for a gap is anchored to: the button of its band, else the
 * middle of its (empty) parent, else the middle of the frame. A box the size
 * of the button, in the same space as `boxes`.
 */
export function slotAnchor(
  slot: InsertSlot,
  boxes: ReadonlyMap<string, Box>,
  frame: Box,
): Box {
  const geometry = slotGeometry(slot, boxes);
  const parent =
    slot.parentId === null ? null : (boxes.get(slot.parentId) ?? null);
  const center =
    geometry?.center ??
    (parent === null
      ? { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 }
      : {
          x: parent.left + parent.width / 2,
          y: parent.top + parent.height / 2,
        });
  return {
    left: center.x - ADD_BUTTON_SIZE / 2,
    top: center.y - ADD_BUTTON_SIZE / 2,
    width: ADD_BUTTON_SIZE,
    height: ADD_BUTTON_SIZE,
  };
}

/** Where the picker goes: 320px wide, kept 8px inside the frame, below the anchor or above it where there is more room. */
export type PickerPlacement = {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
  readonly side: 'below' | 'above';
};

export const PICKER_WIDTH = 320;
const PICKER_MAX_HEIGHT = 360;
const PICKER_GAP = 8;
const PICKER_MIN_HEIGHT = 160;

export function pickerPlacement(anchor: Box, frame: Box): PickerPlacement {
  const cap = Math.max(
    PICKER_MIN_HEIGHT,
    Math.min(PICKER_MAX_HEIGHT, frame.height - 16),
  );
  const below =
    frame.top + frame.height - (anchor.top + anchor.height) - PICKER_GAP * 2;
  const above = anchor.top - frame.top - PICKER_GAP * 2;
  const side: PickerPlacement['side'] =
    below >= cap || below >= above ? 'below' : 'above';
  const room = side === 'below' ? below : above;
  const maxHeight = Math.min(cap, Math.max(room, PICKER_MIN_HEIGHT));
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(
    frame.left + PICKER_GAP,
    Math.min(
      centre - PICKER_WIDTH / 2,
      frame.left + frame.width - PICKER_GAP - PICKER_WIDTH,
    ),
  );
  // With too little room on either side the picker overlaps its anchor rather than leave the frame.
  const top =
    side === 'below'
      ? Math.min(
          anchor.top + anchor.height + PICKER_GAP,
          frame.top + frame.height - PICKER_GAP - maxHeight,
        )
      : Math.max(anchor.top - PICKER_GAP, frame.top + PICKER_GAP + maxHeight);
  return { left, top, maxHeight, side };
}
