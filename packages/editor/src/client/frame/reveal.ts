/**
 * Brings an item of the framed site into view. Only the frame window's scroll
 * position changes: no class, style or attribute is written into the site.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { measureLoose } from '../overlay/boxes.js';
import { TOOLBAR_ROOM } from '../overlay/geometry.js';

/**
 * Where the frame should scroll to for an item to be seen, or null when it is
 * already fully inside the viewport. `item.top` is measured against the
 * viewport (what `getBoundingClientRect` gives). An item that fits is
 * centred; a taller one gets its top the toolbar's room below the viewport
 * top. The result is never negative.
 */
export function revealScrollTop(
  item: { readonly top: number; readonly height: number },
  viewportHeight: number,
  scrollY: number,
): number | null {
  if (item.top >= 0 && item.top + item.height <= viewportHeight) return null;
  const absoluteTop = scrollY + item.top;
  const target =
    item.height <= viewportHeight
      ? absoluteTop - (viewportHeight - item.height) / 2
      : absoluteTop - TOOLBAR_ROOM;
  return Math.max(0, target);
}

/**
 * Scrolls the framed site so the block `id` is in view. Does nothing for a
 * block the site does not lay out (no client rects, or `display: contents`).
 * The scroll is smooth unless the editor asked for reduced motion.
 */
export function revealInFrame(frame: HTMLIFrameElement, id: string): void {
  const doc = frame.contentDocument;
  const view = doc?.defaultView ?? null;
  if (doc === null || view === null) return;
  const element = doc.querySelector(
    `[${EDIT_ATTRIBUTE.block}="${view.CSS.escape(id)}"]`,
  );
  if (element === null || element.getClientRects().length === 0) return;
  const box = measureLoose(element, view);
  if (box === null) return;
  const top = revealScrollTop(
    box,
    doc.documentElement.clientHeight,
    view.scrollY,
  );
  if (top === null) return;
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.scrollTo({ top, behavior: reduced ? 'instant' : 'smooth' });
}
