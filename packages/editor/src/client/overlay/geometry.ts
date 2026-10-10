/**
 * The geometry of the hover overlay, as pure functions.
 *
 * Two coordinate spaces meet here. The framed site measures its elements
 * against its own viewport (`getBoundingClientRect` inside the frame), and the
 * overlay is drawn in the shell's document. The two differ by where the
 * frame's content box sits in the shell, so every element rectangle is moved
 * by that origin on its way to the overlay. Nothing here touches a DOM, which
 * keeps every placement rule testable without a browser.
 */

/** A box in pixels. */
export type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/** A point in pixels. */
export type Point = {
  readonly x: number;
  readonly y: number;
};

/** The height of the label chip. */
export const CHIP_HEIGHT = 20;

/** How far the chip sits inside an outline when there is no room above it,
 * and how far below the frame top it is pinned. */
export const CHIP_INSET = 4;

/** The outline's box in the shell's coordinates: the element's box inside the
 * frame, moved by where the frame's content box starts in the shell. */
export function outlineRect(elementRect: Box, frameContentOrigin: Point): Box {
  return {
    left: elementRect.left + frameContentOrigin.x,
    top: elementRect.top + frameContentOrigin.y,
    width: elementRect.width,
    height: elementRect.height,
  };
}

/** Whether an element can be outlined: it has a size and generates a box. An
 * element with `display: contents` reports an empty rectangle of its own and
 * its children are what is on screen, so it is skipped for them. */
export function isMeasurable(
  rect: Pick<Box, 'width' | 'height'>,
  display: string,
): boolean {
  return display !== 'contents' && rect.width > 0 && rect.height > 0;
}

/** Where the label chip goes. `hidden` means no part of the outline is inside
 * the frame, so nothing is drawn. */
export type ChipPlacement = {
  readonly mode: 'above' | 'inside' | 'pinned' | 'hidden';
  readonly left: number;
  readonly top: number;
};

/**
 * Places the chip for an outline.
 *
 * - `above`: the chip's bottom edge rests on the outline's top edge, when
 *   there is room for the whole chip inside the frame above it.
 * - `inside`: not enough room above, so the chip sits 4px into the outline's
 *   top-left corner.
 * - `pinned`: the outline's top has scrolled out of the frame but some of it
 *   is still visible, so the chip stays 4px below the frame's top.
 *
 * `outline` and `frame` are in the same coordinate space, and so are the
 * returned `left` and `top`. The chip never starts left of the frame.
 */
export function chipPlacement(input: {
  readonly outline: Box;
  readonly frame: Box;
  readonly chipHeight?: number;
}): ChipPlacement {
  const { outline, frame } = input;
  const chipHeight = input.chipHeight ?? CHIP_HEIGHT;
  const outlineBottom = outline.top + outline.height;
  const inside = Math.max(outline.left + CHIP_INSET, frame.left + CHIP_INSET);

  if (outline.top < frame.top) {
    if (outlineBottom <= frame.top) {
      return { mode: 'hidden', left: inside, top: frame.top };
    }
    return { mode: 'pinned', left: inside, top: frame.top + CHIP_INSET };
  }
  if (outline.top - chipHeight >= frame.top) {
    return {
      mode: 'above',
      left: Math.max(outline.left, frame.left),
      top: outline.top - chipHeight,
    };
  }
  return { mode: 'inside', left: inside, top: outline.top + CHIP_INSET };
}

/** Whether two boxes are the same box. */
export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}
