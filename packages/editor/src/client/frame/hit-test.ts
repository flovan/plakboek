/**
 * Maps a pointer position in the framed site to the blocks under it.
 *
 * Frame nodes belong to the frame's realm, so nothing here uses `instanceof`:
 * an element is recognised by its shape. Measuring and `display: contents`
 * handling are the same rules the hover overlay uses, so a click selects the
 * block the outline shows.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { isMeasurable } from '../overlay/geometry.js';

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === 1 &&
    'closest' in value
  );
}

function measurable(element: Element, doc: Document): boolean {
  const rect = element.getBoundingClientRect();
  const display = doc.defaultView?.getComputedStyle(element).display ?? '';
  return isMeasurable(rect, display);
}

/**
 * The ids of the blocks under the point, innermost first. A block with no box
 * of its own (zero size or `display: contents`) is skipped; an element between
 * blocks that carries no block id is passed over. Empty when nothing is there.
 */
export function hitChain(
  frameDocument: Document,
  x: number,
  y: number,
): readonly string[] {
  const start = frameDocument.elementFromPoint(x, y);
  const ids: string[] = [];
  let candidate: Element | null = isElement(start)
    ? start.closest(BLOCK_SELECTOR)
    : null;
  while (candidate !== null) {
    const id = candidate.getAttribute(EDIT_ATTRIBUTE.block);
    if (id !== null && id !== '' && measurable(candidate, frameDocument)) {
      ids.push(id);
    }
    candidate = candidate.parentElement?.closest(BLOCK_SELECTOR) ?? null;
  }
  return ids;
}
