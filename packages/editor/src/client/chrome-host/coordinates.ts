/**
 * Chrome inside the frame is placed once, in the frame document's own
 * coordinates, and scrolls with it. These two functions move a box measured
 * against the frame's viewport into those coordinates, and name the part of
 * the document that is on screen.
 */
import type { Box } from '../overlay/geometry.js';

/** How far the frame's window is scrolled. */
export type ScrollOffset = {
  readonly scrollX: number;
  readonly scrollY: number;
};

/** A frame window's scroll offset and viewport size. */
export type FrameView = ScrollOffset & {
  readonly innerWidth: number;
  readonly innerHeight: number;
};

/** A viewport rectangle (`getBoundingClientRect`) in document coordinates. */
export function documentBox(rect: Box, view: ScrollOffset): Box {
  return {
    left: rect.left + view.scrollX,
    top: rect.top + view.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

/** The part of the document the frame currently shows, in document coordinates. */
export function visibleDocumentBox(view: FrameView): Box {
  return {
    left: view.scrollX,
    top: view.scrollY,
    width: view.innerWidth,
    height: view.innerHeight,
  };
}
