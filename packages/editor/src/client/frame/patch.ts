import { EDIT_ATTRIBUTE } from '@plakboek/render';
import type { PatchDomView, PatchStep } from './patch-plan.js';

/**
 * Applies planned patch steps to the frame document. Everything here runs in
 * the frame's realm, so nodes are never tested with `instanceof` (their
 * constructors belong to the frame's window) and markup is parsed in a
 * `template` element created by the frame document: a parsed `<script>`
 * stays inert there, and block scripts re-bind through the `rendered` hook
 * instead of re-running.
 */

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;
const INLINE_SELECTOR = `[${EDIT_ATTRIBUTE.inlineEditing}]`;

/** Fired on the frame document when an inline edit ends, so deferred patches
 * can be planned again. */
export const INLINE_EDIT_END_EVENT = 'plakboek:inline-edit-end';

function escapeAttributeValue(doc: Document, value: string): string {
  const css = doc.defaultView?.CSS;
  return typeof css?.escape === 'function'
    ? css.escape(value)
    : value.replaceAll(/["\\]/g, '\\$&');
}

function findBlock(doc: Document, id: string): Element | null {
  return doc.querySelector(
    `[${EDIT_ATTRIBUTE.block}="${escapeAttributeValue(doc, id)}"]`,
  );
}

function isTopLevelBlock(element: Element): boolean {
  return (
    element.hasAttribute(EDIT_ATTRIBUTE.block) &&
    element.parentElement?.closest(BLOCK_SELECTOR) == null
  );
}

function topLevelBlocks(doc: Document): Element[] {
  return [...doc.querySelectorAll(BLOCK_SELECTOR)].filter(isTopLevelBlock);
}

/** Whether the element, or anything inside it, is marked as edited in place. */
export function isInlineEditingWithin(element: Element): boolean {
  return (
    element.hasAttribute(EDIT_ATTRIBUTE.inlineEditing) ||
    element.querySelector(INLINE_SELECTOR) !== null
  );
}

/** What the planner asks about the frame, read from its DOM. */
export function domViewOf(frameDocument: Document): PatchDomView {
  return {
    has: (id) => findBlock(frameDocument, id) !== null,
    inlineEditing: (id) => {
      const element = findBlock(frameDocument, id);
      return element !== null && isInlineEditingWithin(element);
    },
    rootContainer: topLevelBlocks(frameDocument).length > 0,
  };
}

/** Marks a block element as edited in place: no patch touches it until
 * `endInlineEdit`. */
export function beginInlineEdit(element: Element): void {
  element.setAttribute(EDIT_ATTRIBUTE.inlineEditing, '');
}

/** Removes the mark and tells the frame document, so a patch held back while
 * it stood can be applied. */
export function endInlineEdit(element: Element): void {
  element.removeAttribute(EDIT_ATTRIBUTE.inlineEditing);
  const doc = element.ownerDocument;
  const EventConstructor = doc.defaultView?.CustomEvent ?? CustomEvent;
  doc.dispatchEvent(
    new EventConstructor(INLINE_EDIT_END_EVENT, {
      detail: { id: element.getAttribute(EDIT_ATTRIBUTE.block) },
    }),
  );
}

/** The single element a fragment holds, or null when it holds none or more. */
function parseFragment(doc: Document, html: string): Element | null {
  const template = doc.createElement('template');
  template.innerHTML = html;
  const { content } = template;
  return content.childElementCount === 1 ? content.firstElementChild : null;
}

/** Moves the listed top-level blocks, in order, to the front of the run of
 * top-level blocks they sit in. Nodes keep their identity. */
function orderRoots(doc: Document, order: readonly string[]): void {
  const roots = topLevelBlocks(doc);
  const first = roots[0];
  if (first === undefined) return;
  const parent = first.parentNode;
  if (parent === null) return;

  const nextRoot = (from: Element): Element | null => {
    let next = from.nextElementSibling;
    while (next !== null && !isTopLevelBlock(next))
      next = next.nextElementSibling;
    return next;
  };

  let reference: Element | null = first;
  for (const id of new Set(order)) {
    const element = findBlock(doc, id);
    if (element === null || element.parentNode !== parent) continue;
    if (element === reference) reference = nextRoot(element);
    else parent.insertBefore(element, reference);
  }
}

export type PatchResult = {
  /** Ids of the elements that were replaced with new markup. */
  readonly replaced: readonly string[];
  /** Whether the frame must be reloaded; the caller does that with
   * `contentWindow.location.replace(frameUrl)`. */
  readonly reloadNeeded: boolean;
};

/**
 * Runs the steps, then puts the frame's scroll position back: the browser
 * shifts it by the height change of content above the viewport, and the
 * editor promises no drift. A step that cannot be applied (an anchor is
 * missing, a fragment is not one element) stops the run and asks for a reload.
 */
export function applyPatchSteps(
  frameDocument: Document,
  steps: readonly PatchStep[],
): PatchResult {
  const scroller = frameDocument.scrollingElement;
  const scrollTop = scroller?.scrollTop ?? 0;
  const replaced: string[] = [];
  let reloadNeeded = false;

  for (const step of steps) {
    if (step.kind === 'reload') {
      reloadNeeded = true;
      break;
    }

    if (step.kind === 'remove') {
      findBlock(frameDocument, step.id)?.remove();
      continue;
    }

    if (step.kind === 'order-roots') {
      orderRoots(frameDocument, step.order);
      continue;
    }

    const element = parseFragment(frameDocument, step.html);
    if (element === null) {
      reloadNeeded = true;
      break;
    }

    if (step.kind === 'replace') {
      const current = findBlock(frameDocument, step.id);
      if (current === null) {
        reloadNeeded = true;
        break;
      }
      current.replaceWith(element);
      replaced.push(step.id);
      continue;
    }

    const last = topLevelBlocks(frameDocument).at(-1);
    if (last === undefined) {
      reloadNeeded = true;
      break;
    }
    last.after(element);
  }

  if (scroller !== null && scroller.scrollTop !== scrollTop)
    scroller.scrollTop = scrollTop;

  return { replaced, reloadNeeded };
}
