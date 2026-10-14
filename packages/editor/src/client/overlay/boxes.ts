/**
 * Keeps the boxes of the items the editor draws against current: the siblings
 * a gap sits between, the blocks that show a needs-input marker and the
 * columns that hold nothing. The hover tracker follows one pointer; this one
 * follows a set of items the caller names, in one pass per animation frame
 * however many scrolls, resizes and mutations asked for it.
 *
 * It reads the identity attributes the live render puts on every block
 * (`EDIT_ATTRIBUTE`) and never changes the framed site: its listeners are
 * passive and nothing is added to the framed document.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { sameBox, type Box } from './geometry.js';

/** The smallest box an item that renders at no size is given, so it can still be pointed at. */
export const GHOST_SIZE = 24;

/** What the overlay draws from. Item boxes are in the frame's own coordinates, `frame` is the frame's content box in the shell's. */
export type BoxesState = {
  readonly frame: Box;
  readonly boxes: ReadonlyMap<string, Box>;
  /** The ids of the columns the render marked empty. */
  readonly empty: readonly string[];
  /** The ids of the items fixed to the viewport: they sit in no gap between siblings. */
  readonly fixed: readonly string[];
};

export type BoxTrackerOptions = {
  /** The ids to measure now; read again on every measurement. */
  readonly ids: () => readonly string[];
  readonly onChange: (state: BoxesState | null) => void;
};

export type BoxTracker = {
  /** Measures again, after the ids the caller wants changed. */
  readonly refresh: () => void;
  readonly dispose: () => void;
};

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;
const EMPTY_SELECTOR = `[${EDIT_ATTRIBUTE.empty}]`;

function hasObservers(view: Window): view is Window & typeof globalThis {
  return (
    typeof Reflect.get(view, 'ResizeObserver') === 'function' &&
    typeof Reflect.get(view, 'MutationObserver') === 'function'
  );
}

/** The element's box, a ghost box where it takes up no room, and null where it generates none. */
export function measureLoose(element: Element, view: Window): Box | null {
  if (view.getComputedStyle(element).display === 'contents') return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width > 0 ? rect.width : GHOST_SIZE,
    height: rect.height > 0 ? rect.height : GHOST_SIZE,
  };
}

function sameState(a: BoxesState | null, b: BoxesState | null): boolean {
  if (a === null || b === null) return a === b;
  if (!sameBox(a.frame, b.frame)) return false;
  if (
    a.boxes.size !== b.boxes.size ||
    a.empty.length !== b.empty.length ||
    a.fixed.length !== b.fixed.length
  ) {
    return false;
  }
  if (a.empty.some((id, at) => id !== b.empty[at])) return false;
  if (a.fixed.some((id, at) => id !== b.fixed[at])) return false;
  for (const [id, box] of a.boxes) {
    if (!sameBox(box, b.boxes.get(id) ?? null)) return false;
  }
  return true;
}

/** Starts following `frame`, through every document it loads. */
export function createBoxTracker(
  frame: HTMLIFrameElement,
  options: BoxTrackerOptions,
): BoxTracker {
  const topWindow = frame.ownerDocument.defaultView;
  if (topWindow === null) {
    return { refresh: () => undefined, dispose: () => undefined };
  }
  const shellWindow = topWindow;
  let detachDocument: (() => void) | null = null;
  let animationFrame = 0;
  let last: BoxesState | null = null;

  function contentBox(): Box {
    const rect = frame.getBoundingClientRect();
    return {
      left: rect.left + frame.clientLeft,
      top: rect.top + frame.clientTop,
      width: frame.clientWidth,
      height: frame.clientHeight,
    };
  }

  function emit(next: BoxesState | null): void {
    if (sameState(last, next)) return;
    last = next;
    options.onChange(next);
  }

  function measureAll(): void {
    animationFrame = 0;
    const doc = frame.contentDocument;
    const view = doc?.defaultView ?? null;
    const frameBox = contentBox();
    if (
      doc === null ||
      view === null ||
      doc.URL === 'about:blank' ||
      frameBox.width === 0 ||
      frameBox.height === 0
    ) {
      emit(null);
      return;
    }
    const byId = new Map<string, Element>();
    for (const element of doc.querySelectorAll(BLOCK_SELECTOR)) {
      const id = element.getAttribute(EDIT_ATTRIBUTE.block);
      if (id !== null && !byId.has(id)) byId.set(id, element);
    }
    const boxes = new Map<string, Box>();
    const fixed: string[] = [];
    for (const id of options.ids()) {
      const element = byId.get(id);
      if (element === undefined) continue;
      const box = measureLoose(element, view);
      if (box === null) continue;
      boxes.set(id, box);
      if (view.getComputedStyle(element).position === 'fixed') fixed.push(id);
    }
    const empty: string[] = [];
    for (const element of doc.querySelectorAll(EMPTY_SELECTOR)) {
      const id = element.getAttribute(EDIT_ATTRIBUTE.block);
      if (id === null) continue;
      const box = measureLoose(element, view);
      if (box === null) continue;
      empty.push(id);
      boxes.set(id, box);
    }
    emit({ frame: frameBox, boxes, empty, fixed });
  }

  function schedule(): void {
    if (animationFrame !== 0) return;
    animationFrame = shellWindow.requestAnimationFrame(measureAll);
  }

  function attach(): void {
    detachDocument?.();
    detachDocument = null;
    const doc = frame.contentDocument;
    const view = doc?.defaultView ?? null;
    if (doc === null || view === null || doc.URL === 'about:blank') {
      emit(null);
      return;
    }
    if (!hasObservers(view)) return;
    const resizeObserver = new view.ResizeObserver(schedule);
    const mutationObserver = new view.MutationObserver(schedule);
    resizeObserver.observe(doc.documentElement);
    if (doc.body !== null) {
      resizeObserver.observe(doc.body);
      mutationObserver.observe(doc.body, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    view.addEventListener('scroll', schedule, { passive: true });
    view.addEventListener('resize', schedule, { passive: true });
    detachDocument = () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      view.removeEventListener('scroll', schedule);
      view.removeEventListener('resize', schedule);
    };
    schedule();
  }

  shellWindow.addEventListener('resize', schedule, { passive: true });
  // The layout toggle changes the frame's size without resizing the window.
  const frameObserver = new ResizeObserver(schedule);
  frameObserver.observe(frame);
  frame.addEventListener('load', attach);
  if (frame.contentDocument?.readyState === 'complete') attach();

  return {
    refresh: schedule,
    dispose: () => {
      frame.removeEventListener('load', attach);
      shellWindow.removeEventListener('resize', schedule);
      frameObserver.disconnect();
      detachDocument?.();
      detachDocument = null;
      if (animationFrame !== 0)
        shellWindow.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    },
  };
}
