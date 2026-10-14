import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { siblingAxis, type Box } from '../overlay/geometry.js';

function escapeValue(doc: Document, value: string): string {
  const css = doc.defaultView?.CSS;
  return typeof css?.escape === 'function'
    ? css.escape(value)
    : value.replaceAll(/["\\]/g, '\\$&');
}

/**
 * Whether the siblings sit side by side or stacked in the framed site, read
 * from where their elements are. Siblings the site did not render (or that
 * have no box) are left out, so fewer than two measurable ones stack.
 */
export function measureSiblingAxis(
  frameDocument: Document,
  siblingIds: readonly string[],
): 'horizontal' | 'vertical' {
  const boxes: Box[] = [];
  for (const id of siblingIds) {
    const element = frameDocument.querySelector(
      `[${EDIT_ATTRIBUTE.block}="${escapeValue(frameDocument, id)}"]`,
    );
    if (element === null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    boxes.push({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return siblingAxis(boxes);
}
