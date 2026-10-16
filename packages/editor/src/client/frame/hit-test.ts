/**
 * Maps a pointer position in the framed site to the blocks under it.
 *
 * Frame nodes belong to the frame's realm, so nothing here uses `instanceof`:
 * an element is recognised by its shape. Measuring and `display: contents`
 * handling are the same rules the hover overlay uses, so a click selects the
 * block the outline shows.
 *
 * A block that renders at no size (a new Text with no text) is outlined and
 * flagged from a ghost box, so it is pointed at through that same box: the
 * 24px square from its own top-left corner, each zero dimension widened. It
 * is only hit where the strict chain holds its parent block, so a sized block
 * painted over the spot keeps the click.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { GHOST_SIZE } from '../overlay/boxes.js';
import { isMeasurable } from '../overlay/geometry.js';

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;

export type HitOptions = {
  /** Count a zero-size block through its ghost box. On unless `false`. */
  readonly ghosts?: boolean;
};

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === 1 &&
    'closest' in value
  );
}

function displayOf(element: Element, doc: Document): string {
  return doc.defaultView?.getComputedStyle(element).display ?? '';
}

function measurable(element: Element, doc: Document): boolean {
  return isMeasurable(element.getBoundingClientRect(), displayOf(element, doc));
}

function hasId(element: Element): boolean {
  const id = element.getAttribute(EDIT_ATTRIBUTE.block);
  return id !== null && id !== '';
}

/** The measurable blocks under the point, innermost first. */
function strictBlocks(
  frameDocument: Document,
  x: number,
  y: number,
): Element[] {
  const start = frameDocument.elementFromPoint(x, y);
  const found: Element[] = [];
  let candidate: Element | null = isElement(start)
    ? start.closest(BLOCK_SELECTOR)
    : null;
  while (candidate !== null) {
    if (hasId(candidate) && measurable(candidate, frameDocument)) {
      found.push(candidate);
    }
    candidate = candidate.parentElement?.closest(BLOCK_SELECTOR) ?? null;
  }
  return found;
}

function parentBlockOf(element: Element): Element | null {
  return element.parentElement?.closest(BLOCK_SELECTOR) ?? null;
}

function depthOf(element: Element): number {
  let depth = 0;
  let current = parentBlockOf(element);
  while (current !== null) {
    depth += 1;
    current = parentBlockOf(current);
  }
  return depth;
}

/** Whether the point is inside the zero-size block's ghost box. */
function inGhostBox(rect: DOMRect, x: number, y: number): boolean {
  const width = rect.width > 0 ? rect.width : GHOST_SIZE;
  const height = rect.height > 0 ? rect.height : GHOST_SIZE;
  return (
    x >= rect.left &&
    x < rect.left + width &&
    y >= rect.top &&
    y < rect.top + height
  );
}

/** The deepest zero-size block whose ghost box holds the point and whose parent block is hit strictly. */
function ghostAt(
  frameDocument: Document,
  strict: readonly Element[],
  x: number,
  y: number,
): Element | null {
  let best: Element | null = null;
  let bestDepth = -1;
  for (const element of frameDocument.querySelectorAll(BLOCK_SELECTOR)) {
    if (!hasId(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) continue;
    if (!inGhostBox(rect, x, y)) continue;
    if (element.getClientRects().length === 0) continue;
    if (displayOf(element, frameDocument) === 'contents') continue;
    const parent = parentBlockOf(element);
    const held =
      parent === null ? strict.length === 0 : strict.includes(parent);
    if (!held) continue;
    const depth = depthOf(element);
    if (depth >= bestDepth) {
      best = element;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * The block elements under the point, innermost first. A block with no box of
 * its own (zero size or `display: contents`) is skipped, except as a ghost
 * (see the module comment) unless `ghosts` is `false`; an element between
 * blocks that carries no block id is passed over. Empty when nothing is there.
 */
export function blocksAt(
  frameDocument: Document,
  x: number,
  y: number,
  options: HitOptions = {},
): readonly Element[] {
  const strict = strictBlocks(frameDocument, x, y);
  if (options.ghosts === false) return strict;
  const ghost = ghostAt(frameDocument, strict, x, y);
  if (ghost === null) return strict;
  const chain: Element[] = [ghost];
  let ancestor = parentBlockOf(ghost);
  while (ancestor !== null) {
    if (hasId(ancestor) && displayOf(ancestor, frameDocument) !== 'contents') {
      chain.push(ancestor);
    }
    ancestor = parentBlockOf(ancestor);
  }
  return chain;
}

/** The ids of the blocks under the point, innermost first. */
export function hitChain(
  frameDocument: Document,
  x: number,
  y: number,
  options: HitOptions = {},
): readonly string[] {
  const ids: string[] = [];
  for (const element of blocksAt(frameDocument, x, y, options)) {
    const id = element.getAttribute(EDIT_ATTRIBUTE.block);
    if (id !== null && id !== '') ids.push(id);
  }
  return ids;
}
