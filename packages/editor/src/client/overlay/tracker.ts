/**
 * Finds the block under the pointer in the framed site and keeps its
 * measurements current, so the overlay can draw an outline over it.
 *
 * What it reads: the identity attributes the live render puts on a block's
 * root element (`EDIT_ATTRIBUTE`). What it never does: change the site. It
 * adds no class, style, attribute or element to the framed document, and its
 * listeners only observe, so the site's own clicks, keys and scrolling are
 * untouched:
 *
 * - every listener on the frame's document is passive and in the bubble
 *   phase, and none of them cancels an event or stops it travelling on,
 * - the observers are built from the frame window's own constructors, which
 *   is what the frame's elements belong to.
 *
 * Measuring is coalesced: any number of scrolls, resizes, mutations and
 * pointer moves in one frame cause one measurement in the next animation
 * frame, and a state that has not changed is not reported again. A scroll or
 * a resize moves the content under a pointer that did not move, and the
 * browser sends no pointer event for that, so once the page has been quiet
 * for 100ms the last pointer position is looked up again.
 *
 * Two optional inputs make it the editor's tracker. A `resolve` function
 * decides which of the blocks under the pointer is the hover target (the one a
 * click would select), and a `selection` reader names the selected item and
 * the scope container, whose boxes are measured in the same pass and reported
 * through their own callback.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { measureLoose } from './boxes.js';
import { isMeasurable, sameBox, type Box, type Point } from './geometry.js';

/** What the overlay draws. Element boxes are in the frame's own coordinates,
 * `frame` is the frame's content box in the shell's. */
export type HoverState = {
  readonly blockId: string;
  /** The editor label, or the type key when there is none. */
  readonly label: string;
  readonly kind: 'section' | 'block';
  /** The block stands in for one that renders nothing. */
  readonly unavailable: boolean;
  readonly element: Box;
  /** The nearest section above the element, when there is one. */
  readonly section: Box | null;
  readonly frame: Box;
};

/** The selected item and the scope container, measured in the same pass. */
export type SelectionState = {
  /** The selected item's box in the frame's own coordinates. */
  readonly selected: Box | null;
  /** The scope container's box, when the scope is not the page. */
  readonly scope: Box | null;
  readonly frame: Box;
};

/** Which items the editor has selected, read afresh on every measurement. */
export type SelectionRead = {
  readonly selectedId: string | null;
  readonly scopeId: string | null;
};

export type TrackerOptions = {
  /** Picks the hover target from the ids of the measurable blocks under the
   * pointer, innermost first; `null` hovers nothing. Without it the innermost
   * block is the target. */
  readonly resolve?: (chain: readonly string[]) => string | null;
  readonly selection?: {
    readonly read: () => SelectionRead;
    readonly onChange: (state: SelectionState | null) => void;
  };
};

export type HoverTracker = {
  /** Looks the pointer up again and measures again, after the inputs changed. */
  readonly refresh: () => void;
  /** Stops listening and releases every observer. */
  readonly dispose: () => void;
};

/** How long the page must be quiet before the pointer is looked up again. */
export const SETTLE_MS = 100;

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;
const SECTION_SELECTOR = `[${EDIT_ATTRIBUTE.kind}="section"]`;

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === 1 &&
    'closest' in value
  );
}

/** A frame window that has the observer constructors, which every browser's
 * window does. */
function hasObservers(view: Window): view is Window & typeof globalThis {
  return (
    typeof Reflect.get(view, 'ResizeObserver') === 'function' &&
    typeof Reflect.get(view, 'MutationObserver') === 'function'
  );
}

function boxOf(rect: DOMRect): Box {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/** The element's box, or null when it cannot be outlined. */
function measure(element: Element, view: Window): Box | null {
  const rect = element.getBoundingClientRect();
  return isMeasurable(rect, view.getComputedStyle(element).display)
    ? boxOf(rect)
    : null;
}

/** The measurable blocks that hold `from`, innermost first, climbing past any
 * that generate no box of their own. */
function blocksAround(
  from: Element | null,
  view: Window,
): readonly { readonly id: string; readonly element: Element }[] {
  const found: { id: string; element: Element }[] = [];
  let candidate = from?.closest(BLOCK_SELECTOR) ?? null;
  while (candidate !== null) {
    if (measure(candidate, view) !== null) {
      found.push({
        id: candidate.getAttribute(EDIT_ATTRIBUTE.block) ?? '',
        element: candidate,
      });
    }
    candidate = candidate.parentElement?.closest(BLOCK_SELECTOR) ?? null;
  }
  return found;
}

/** The block the hover is on: the innermost measurable one, or the one
 * `resolve` picks from the chain. */
function resolveTarget(
  from: Element | null,
  view: Window,
  resolve: TrackerOptions['resolve'],
): Element | null {
  const chain = blocksAround(from, view);
  if (resolve === undefined) return chain[0]?.element ?? null;
  const id = resolve(chain.map((entry) => entry.id));
  return chain.find((entry) => entry.id === id)?.element ?? null;
}

/** The element of a block id in a frame document, or null. */
function elementOfBlock(frameDocument: Document, id: string): Element | null {
  const css = frameDocument.defaultView?.CSS;
  const escaped =
    typeof css?.escape === 'function'
      ? css.escape(id)
      : id.replaceAll(/["\\]/g, '\\$&');
  return frameDocument.querySelector(`[${EDIT_ATTRIBUTE.block}="${escaped}"]`);
}

/** The nearest measurable section above `target`. */
function resolveSection(target: Element, view: Window): Element | null {
  let candidate = target.parentElement?.closest(SECTION_SELECTOR) ?? null;
  while (candidate !== null) {
    if (measure(candidate, view) !== null) return candidate;
    candidate = candidate.parentElement?.closest(SECTION_SELECTOR) ?? null;
  }
  return null;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

function sameState(a: HoverState | null, b: HoverState | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.blockId === b.blockId &&
    a.label === b.label &&
    a.kind === b.kind &&
    a.unavailable === b.unavailable &&
    sameBox(a.element, b.element) &&
    sameBox(a.section, b.section) &&
    sameBox(a.frame, b.frame)
  );
}

function sameSelection(
  a: SelectionState | null,
  b: SelectionState | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    sameBox(a.selected, b.selected) &&
    sameBox(a.scope, b.scope) &&
    sameBox(a.frame, b.frame)
  );
}

/** What is attached to one document of the frame. */
type Attached = {
  readonly document: Document;
  readonly view: Window & typeof globalThis;
  readonly resizeObserver: ResizeObserver;
  readonly detach: () => void;
};

/**
 * Starts tracking the pointer over `frame`. `onChange` is called with the
 * state to draw, or `null` when nothing is hovered, whenever that changes.
 * The tracker follows the frame through every document it loads.
 */
export function createHoverTracker(
  frame: HTMLIFrameElement,
  onChange: (state: HoverState | null) => void,
  options: TrackerOptions = {},
): HoverTracker {
  const topWindow = frame.ownerDocument.defaultView;
  if (topWindow === null) {
    return { refresh: () => undefined, dispose: () => undefined };
  }
  return track(frame, topWindow, onChange, options);
}

function track(
  frame: HTMLIFrameElement,
  topWindow: Window,
  onChange: (state: HoverState | null) => void,
  options: TrackerOptions,
): HoverTracker {
  const topDocument = frame.ownerDocument;
  let attached: Attached | null = null;
  let target: Element | null = null;
  let section: Element | null = null;
  /** The pointer in the shell's coordinates, so a change in where the frame
   * sits (the layout toggle) can be followed. */
  let pointer: Point | null = null;
  let last: HoverState | null = null;
  let lastSelection: SelectionState | null = null;
  /** The selected item and its scope container, observed for size changes. */
  let selectedElement: Element | null = null;
  let scopeElement: Element | null = null;
  let animationFrame = 0;
  let settleTimer: number | null = null;

  /** Where the frame's content box starts in the shell. */
  function contentBox(): Box {
    const rect = frame.getBoundingClientRect();
    return {
      left: rect.left + frame.clientLeft,
      top: rect.top + frame.clientTop,
      width: frame.clientWidth,
      height: frame.clientHeight,
    };
  }

  function emit(next: HoverState | null): void {
    if (sameState(last, next)) return;
    last = next;
    onChange(next);
  }

  function emitSelection(next: SelectionState | null): void {
    if (sameSelection(lastSelection, next)) return;
    lastSelection = next;
    options.selection?.onChange(next);
  }

  /** Watches the target, its section and the selection's elements for size
   * changes. */
  function observe(): void {
    const current = attached;
    if (current === null) return;
    current.resizeObserver.disconnect();
    for (const element of [target, section, selectedElement, scopeElement]) {
      if (element !== null) current.resizeObserver.observe(element);
    }
  }

  function hoverState(current: Attached, frameBox: Box): HoverState | null {
    const hovered = target;
    if (hovered === null || !hovered.isConnected) {
      if (hovered !== null) setTarget(null);
      return null;
    }
    const element = measure(hovered, current.view);
    if (element === null) return null;
    const container = section;
    const sectionBox =
      container !== null && container.isConnected
        ? measure(container, current.view)
        : null;
    const kind: HoverState['kind'] =
      hovered.getAttribute(EDIT_ATTRIBUTE.kind) === 'section'
        ? 'section'
        : 'block';
    return {
      blockId: hovered.getAttribute(EDIT_ATTRIBUTE.block) ?? '',
      label:
        nonEmpty(hovered.getAttribute(EDIT_ATTRIBUTE.label)) ??
        nonEmpty(hovered.getAttribute(EDIT_ATTRIBUTE.type)) ??
        '',
      kind,
      unavailable: hovered.hasAttribute(EDIT_ATTRIBUTE.unavailable),
      element,
      section: sectionBox,
      frame: frameBox,
    };
  }

  function selectionState(
    current: Attached,
    frameBox: Box,
  ): SelectionState | null {
    const reader = options.selection;
    if (reader === undefined) return null;
    const { selectedId, scopeId } = reader.read();
    const found = (id: string | null): Element | null =>
      id === null ? null : elementOfBlock(current.document, id);
    const nextSelected = found(selectedId);
    const nextScope = found(scopeId);
    if (nextSelected !== selectedElement || nextScope !== scopeElement) {
      selectedElement = nextSelected;
      scopeElement = nextScope;
      observe();
    }
    // A selected item that takes up no room (a new block with no text yet) is
    // still outlined, in a box big enough to see and to hang the toolbar from.
    const selected =
      nextSelected === null ? null : measureLoose(nextSelected, current.view);
    const scope = nextScope === null ? null : measure(nextScope, current.view);
    if (selected === null && scope === null) return null;
    return { selected, scope, frame: frameBox };
  }

  function update(): void {
    animationFrame = 0;
    const current = attached;
    const frameBox = contentBox();
    if (current === null || frameBox.width === 0 || frameBox.height === 0) {
      emit(null);
      emitSelection(null);
      return;
    }
    emit(hoverState(current, frameBox));
    emitSelection(selectionState(current, frameBox));
  }

  /** Asks for a measurement in the next animation frame; any number of asks
   * before it runs share it. */
  function schedule(): void {
    if (animationFrame !== 0) return;
    animationFrame = topWindow.requestAnimationFrame(update);
  }

  function setTarget(next: Element | null): void {
    const current = attached;
    if (next === target) return;
    target = next;
    section =
      next !== null && current !== null
        ? resolveSection(next, current.view)
        : null;
    if (current === null) return;
    observe();
  }

  /** The page moved under a pointer that did not: look the pointer up again
   * once the page has been quiet. */
  function settle(): void {
    settleTimer = null;
    const current = attached;
    if (current === null || pointer === null) return;
    const box = contentBox();
    const x = pointer.x - box.left;
    const y = pointer.y - box.top;
    if (x < 0 || y < 0 || x >= box.width || y >= box.height) {
      setTarget(null);
    } else {
      setTarget(
        resolveTarget(
          current.document.elementFromPoint(x, y),
          current.view,
          options.resolve,
        ),
      );
    }
    schedule();
  }

  function scheduleSettle(): void {
    if (settleTimer !== null) topWindow.clearTimeout(settleTimer);
    settleTimer = topWindow.setTimeout(settle, SETTLE_MS);
  }

  function changed(): void {
    schedule();
    scheduleSettle();
  }

  function detach(): void {
    attached?.detach();
    attached = null;
    target = null;
    section = null;
    selectedElement = null;
    scopeElement = null;
    pointer = null;
  }

  function attach(): void {
    detach();
    emit(null);
    emitSelection(null);
    const frameDocument = frame.contentDocument;
    if (frameDocument === null || frameDocument.URL === 'about:blank') return;
    const view = frameDocument.defaultView;
    const root = frameDocument.documentElement;
    if (view === null || !hasObservers(view)) return;

    const onPointer = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      const box = contentBox();
      pointer = { x: event.clientX + box.left, y: event.clientY + box.top };
      setTarget(
        resolveTarget(
          isElement(event.target) ? event.target : null,
          view,
          options.resolve,
        ),
      );
      schedule();
    };
    const onLeave = (): void => {
      pointer = null;
      setTarget(null);
      schedule();
    };
    const resizeObserver = new view.ResizeObserver(schedule);
    const mutationObserver = new view.MutationObserver(changed);
    if (frameDocument.body !== null) {
      mutationObserver.observe(frameDocument.body, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    root.addEventListener('pointerover', onPointer, { passive: true });
    root.addEventListener('pointermove', onPointer, { passive: true });
    root.addEventListener('pointerleave', onLeave, { passive: true });
    view.addEventListener('scroll', changed, { passive: true });
    view.addEventListener('resize', changed, { passive: true });

    attached = {
      document: frameDocument,
      view,
      resizeObserver,
      detach: () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        root.removeEventListener('pointerover', onPointer);
        root.removeEventListener('pointermove', onPointer);
        root.removeEventListener('pointerleave', onLeave);
        view.removeEventListener('scroll', changed);
        view.removeEventListener('resize', changed);
      },
    };
    // A selection made before this document loaded is measured in it.
    schedule();
  }

  // The pointer reaching anything of the shell but the frame ends the hover.
  // Events inside the frame never reach the shell's document.
  const onShellPointer = (event: PointerEvent): void => {
    if (event.composedPath()[0] === frame) return;
    if (target === null && pointer === null) return;
    pointer = null;
    setTarget(null);
    schedule();
  };
  const onFrameLeave = (): void => {
    pointer = null;
    setTarget(null);
    schedule();
  };
  topDocument.addEventListener('pointermove', onShellPointer, {
    passive: true,
  });
  frame.addEventListener('pointerleave', onFrameLeave, { passive: true });
  topWindow.addEventListener('resize', changed, { passive: true });
  // The layout toggle changes the frame's size without resizing the window.
  const frameObserver = new ResizeObserver(changed);
  frameObserver.observe(frame);
  frame.addEventListener('load', attach);
  if (frame.contentDocument?.readyState === 'complete') attach();

  return {
    refresh: () => {
      // The inputs changed under a pointer that did not move: look it up
      // again and measure again.
      if (attached !== null && pointer !== null) settle();
      else schedule();
    },
    dispose: () => {
      frame.removeEventListener('load', attach);
      frame.removeEventListener('pointerleave', onFrameLeave);
      topDocument.removeEventListener('pointermove', onShellPointer);
      topWindow.removeEventListener('resize', changed);
      frameObserver.disconnect();
      detach();
      if (animationFrame !== 0) topWindow.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (settleTimer !== null) topWindow.clearTimeout(settleTimer);
      settleTimer = null;
    },
  };
}
