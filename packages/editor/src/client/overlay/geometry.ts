/**
 * The geometry of the overlay, as pure functions.
 *
 * Everything is in the framed document's own coordinates: the overlay is drawn
 * inside that document, so a box measured there (moved by the scroll offset,
 * see `documentBox`) is placed as it is and scrolls with the page. The part of
 * the document the frame shows (`visible`) is only an input to the rules that
 * pick a side. Nothing here touches a DOM, which keeps every placement rule
 * testable without a browser.
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

/** Whether an element can be outlined: it has a size and generates a box. An
 * element with `display: contents` reports an empty rectangle of its own and
 * its children are what is on screen, so it is skipped for them. */
export function isMeasurable(
  rect: Pick<Box, 'width' | 'height'>,
  display: string,
): boolean {
  return display !== 'contents' && rect.width > 0 && rect.height > 0;
}

/** Where the label chip goes. `hidden` means no part of the outline is in
 * the visible part of the document, so nothing is drawn. */
export type ChipPlacement = {
  readonly mode: 'above' | 'inside' | 'sticky' | 'hidden';
  readonly left: number;
  readonly top: number;
};

/**
 * Places the chip for an outline.
 *
 * - `above`: the chip's bottom edge rests on the outline's top edge, when
 *   there is room for the whole chip in the visible part above it.
 * - `inside`: not enough room above, so the chip sits 4px into the outline's
 *   top-left corner.
 * - `sticky`: the outline's top is above the visible part but some of it is
 *   still shown, so the chip is drawn with `position: sticky; top: 4px`
 *   inside a wrapper over the outline and stays 4px below the visible top
 *   while the page scrolls, with no script. `left` and `top` are where it sits
 *   in the visible part when this is decided.
 *
 * `outline` and `visible` are in the same coordinate space, and so are the
 * returned `left` and `top`. The chip never starts left of the visible part.
 */
export function chipPlacement(input: {
  readonly outline: Box;
  readonly visible: Box;
  readonly chipHeight?: number;
}): ChipPlacement {
  const { outline, visible } = input;
  const chipHeight = input.chipHeight ?? CHIP_HEIGHT;
  const outlineBottom = outline.top + outline.height;
  const inside = Math.max(outline.left + CHIP_INSET, visible.left + CHIP_INSET);

  if (outline.top < visible.top) {
    if (outlineBottom <= visible.top) {
      return { mode: 'hidden', left: inside, top: visible.top };
    }
    return { mode: 'sticky', left: inside, top: visible.top + CHIP_INSET };
  }
  if (outline.top - chipHeight >= visible.top) {
    return {
      mode: 'above',
      left: Math.max(outline.left, visible.left),
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

/** The floating toolbar's height (4px padding around 32px buttons). */
export const TOOLBAR_HEIGHT = 40;

/** How far the toolbar sits from the item it belongs to, and from the edge of the visible part. */
export const TOOLBAR_GAP = 8;

/** The room the toolbar needs above or below an item: its height and the gap. */
export const TOOLBAR_ROOM = TOOLBAR_HEIGHT + TOOLBAR_GAP;

/** Where the floating toolbar goes. `pinned` means it sits inside the item,
 * drawn with `position: sticky` so it stays inside the visible top as the page
 * scrolls. */
export type ToolbarPlacement = {
  readonly mode: 'above' | 'below' | 'pinned';
  readonly left: number;
  readonly top: number;
};

/**
 * Places the toolbar for the selected item. All boxes share one coordinate
 * space, and so do the returned `left` and `top`.
 *
 * - `above`: 8px above the item's top edge, when at least 48px of the visible
 *   part lies above the item.
 * - `below`: otherwise 8px below its bottom edge, when 48px of the visible
 *   part lies below it.
 * - `pinned`: when neither fits (an item taller than the frame), 8px inside
 *   the item's visible top-left corner.
 *
 * The toolbar's left edge follows the item's and is kept 8px inside the
 * visible part.
 */
export function toolbarPlacement(input: {
  readonly item: Box;
  readonly visible: Box;
  readonly toolbar: { readonly width: number; readonly height: number };
}): ToolbarPlacement {
  const { item, visible, toolbar } = input;
  const visibleRight = visible.left + visible.width;
  const visibleBottom = visible.top + visible.height;
  const itemBottom = item.top + item.height;

  const clampLeft = (left: number): number =>
    Math.max(
      visible.left + TOOLBAR_GAP,
      Math.min(left, visibleRight - TOOLBAR_GAP - toolbar.width),
    );

  if (item.top - visible.top >= TOOLBAR_ROOM) {
    return {
      mode: 'above',
      left: clampLeft(item.left),
      top: item.top - TOOLBAR_GAP - toolbar.height,
    };
  }
  if (visibleBottom - itemBottom >= TOOLBAR_ROOM) {
    return {
      mode: 'below',
      left: clampLeft(item.left),
      top: itemBottom + TOOLBAR_GAP,
    };
  }
  return {
    mode: 'pinned',
    left: clampLeft(Math.max(item.left, visible.left) + TOOLBAR_GAP),
    top: Math.max(item.top, visible.top) + TOOLBAR_GAP,
  };
}

/** Where a text field's bar goes, in the same coordinate space as its inputs. */
export type FieldBarPlacement = {
  readonly mode: 'above' | 'below' | 'pinned';
  readonly left: number;
  readonly top: number;
};

/**
 * Places the bar of the field being edited (the compact bar of a short text,
 * the text toolbar of a rich one). It follows the field, never the caret.
 *
 * - `above`: 8px above the field's top edge, when the visible part holds the
 *   bar's height plus 8px above the field.
 * - `below`: otherwise 8px below the field's bottom edge, when it holds that
 *   much below the field.
 * - `pinned`: when neither fits (a field taller than the frame), inside the
 *   field's visible top-left corner, 8px in. It is drawn with
 *   `position: sticky` inside a wrapper over the field.
 *
 * The bar's left edge follows the field's and is kept 8px inside the visible
 * part. A field fully scrolled out of the visible part has no bar: the caller
 * checks that with `isVisibleIn` first.
 */
export function fieldBarPlacement(input: {
  readonly field: Box;
  readonly visible: Box;
  readonly height: number;
  readonly width: number;
}): FieldBarPlacement {
  const { field, visible, height, width } = input;
  const room = height + TOOLBAR_GAP;
  const visibleRight = visible.left + visible.width;
  const visibleBottom = visible.top + visible.height;
  const fieldBottom = field.top + field.height;

  const clampLeft = (left: number): number =>
    Math.max(
      visible.left + TOOLBAR_GAP,
      Math.min(left, visibleRight - TOOLBAR_GAP - width),
    );

  if (field.top - visible.top >= room) {
    return {
      mode: 'above',
      left: clampLeft(field.left),
      top: field.top - TOOLBAR_GAP - height,
    };
  }
  if (visibleBottom - fieldBottom >= room) {
    return {
      mode: 'below',
      left: clampLeft(field.left),
      top: fieldBottom + TOOLBAR_GAP,
    };
  }
  return {
    mode: 'pinned',
    left: clampLeft(Math.max(field.left, visible.left) + TOOLBAR_GAP),
    top: Math.max(field.top, visible.top) + TOOLBAR_GAP,
  };
}

/**
 * Whether the siblings sit side by side or stacked, from where their boxes
 * are: when their left edges differ more than their top edges they are
 * horizontal. Fewer than two siblings stack, the toolbar's default.
 */
export function siblingAxis(rects: readonly Box[]): 'horizontal' | 'vertical' {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (first === undefined || last === undefined || rects.length < 2) {
    return 'vertical';
  }
  return Math.abs(last.left - first.left) > Math.abs(last.top - first.top)
    ? 'horizontal'
    : 'vertical';
}

/** Whether any part of the box lies within the visible part's height. */
export function isVisibleIn(item: Box, visible: Box): boolean {
  return (
    item.top + item.height > visible.top &&
    item.top < visible.top + visible.height
  );
}
