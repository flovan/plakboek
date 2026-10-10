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
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
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

export type HoverTracker = {
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

/** The innermost measurable block that holds `from`, climbing past any that
 * generate no box of their own. */
function resolveTarget(from: Element | null, view: Window): Element | null {
  let candidate = from?.closest(BLOCK_SELECTOR) ?? null;
  while (candidate !== null) {
    if (measure(candidate, view) !== null) return candidate;
    candidate = candidate.parentElement?.closest(BLOCK_SELECTOR) ?? null;
  }
  return null;
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
): HoverTracker {
  const topWindow = frame.ownerDocument.defaultView;
  if (topWindow === null) return { dispose: () => undefined };
  return track(frame, topWindow, onChange);
}

function track(
  frame: HTMLIFrameElement,
  topWindow: Window,
  onChange: (state: HoverState | null) => void,
): HoverTracker {
  const topDocument = frame.ownerDocument;
  let attached: Attached | null = null;
  let target: Element | null = null;
  let section: Element | null = null;
  /** The pointer in the shell's coordinates, so a change in where the frame
   * sits (the layout toggle) can be followed. */
  let pointer: Point | null = null;
  let last: HoverState | null = null;
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

  function update(): void {
    animationFrame = 0;
    const current = attached;
    const hovered = target;
    if (current === null || hovered === null || !hovered.isConnected) {
      if (hovered !== null) setTarget(null);
      emit(null);
      return;
    }
    const element = measure(hovered, current.view);
    const frameBox = contentBox();
    if (element === null || frameBox.width === 0 || frameBox.height === 0) {
      emit(null);
      return;
    }
    const container = section;
    const sectionBox =
      container !== null && container.isConnected
        ? measure(container, current.view)
        : null;
    const kind: HoverState['kind'] =
      hovered.getAttribute(EDIT_ATTRIBUTE.kind) === 'section'
        ? 'section'
        : 'block';
    emit({
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
    });
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
    current.resizeObserver.disconnect();
    if (target !== null) current.resizeObserver.observe(target);
    if (section !== null) current.resizeObserver.observe(section);
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
        resolveTarget(current.document.elementFromPoint(x, y), current.view),
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
    pointer = null;
  }

  function attach(): void {
    detach();
    emit(null);
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
        resolveTarget(isElement(event.target) ? event.target : null, view),
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
