/**
 * What a drag reads from the framed page: the box of every block that takes up
 * room, in the frame's own coordinates. A block with no box (zero size,
 * `display: contents`) or one fixed to the viewport sits in no gap between
 * siblings, so it is left out and the slot rules treat it as hidden.
 *
 * Reading is the only thing done to the framed document: nothing is added to
 * it and its scroll position is only changed by the controller's auto-scroll.
 */
import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { isMeasurable, type Box } from '../overlay/geometry.js';
import type { TreeModel } from '../session/tree-model.js';

/** The model, the boxes of the blocks that have one, and the frame's viewport, all in the frame's coordinates. */
export type DragScene = {
  readonly model: TreeModel;
  readonly rects: ReadonlyMap<string, Box>;
  readonly frame: Box;
};

const BLOCK_SELECTOR = `[${EDIT_ATTRIBUTE.block}]`;

/** Reads the scene once; null while the frame has no document of the site. */
export function readScene(
  frame: HTMLIFrameElement,
  model: TreeModel,
): DragScene | null {
  const doc = frame.contentDocument;
  const view = doc?.defaultView ?? null;
  if (doc === null || view === null || doc.URL === 'about:blank') return null;
  const rects = new Map<string, Box>();
  for (const element of doc.querySelectorAll(BLOCK_SELECTOR)) {
    const id = element.getAttribute(EDIT_ATTRIBUTE.block);
    if (id === null || rects.has(id)) continue;
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    if (!isMeasurable(rect, style.display) || style.position === 'fixed') {
      continue;
    }
    rects.set(id, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return {
    model,
    rects,
    frame: {
      left: 0,
      top: 0,
      width: frame.clientWidth,
      height: frame.clientHeight,
    },
  };
}

export type SceneReader = {
  /** The scene, read again after the frame scrolled or resized, was reloaded, or the model changed. */
  readonly read: () => DragScene | null;
  /** Forces the next `read` to measure again. */
  readonly invalidate: () => void;
  readonly dispose: () => void;
};

/**
 * Follows the frame so a drag measures once per change, not once per pointer
 * move. The frame's `scroll` event arrives on the next rendering step, after a
 * scroll the drag's own auto-scroll just made, so `read` also compares the
 * scroll position the scene was measured at with the one the frame has now:
 * boxes from the old position are never paired with a hit test at the new one.
 * A reloaded frame is a new window, so the listeners follow its document.
 */
export function createSceneReader(
  frame: HTMLIFrameElement,
  model: () => TreeModel | null,
): SceneReader {
  let cached: DragScene | null = null;
  let dirty = true;
  let measuredAt = { x: 0, y: 0 };
  let followed: Document | null = null;
  let followedView: Window | null = null;
  const invalidate = (): void => {
    dirty = true;
  };
  const unfollow = (): void => {
    followedView?.removeEventListener('scroll', invalidate);
    followedView?.removeEventListener('resize', invalidate);
    followedView = null;
    followed = null;
  };
  const follow = (): void => {
    const doc = frame.contentDocument;
    if (doc === followed && followedView !== null) return;
    unfollow();
    followed = doc;
    followedView = frame.contentWindow;
    followedView?.addEventListener('scroll', invalidate, { passive: true });
    followedView?.addEventListener('resize', invalidate, { passive: true });
    dirty = true;
  };
  follow();
  return {
    read: () => {
      const current = model();
      if (current === null) return null;
      follow();
      const view = frame.contentWindow;
      const scroll = { x: view?.scrollX ?? 0, y: view?.scrollY ?? 0 };
      if (
        dirty ||
        cached === null ||
        cached.model !== current ||
        scroll.x !== measuredAt.x ||
        scroll.y !== measuredAt.y
      ) {
        cached = readScene(frame, current);
        measuredAt = scroll;
        dirty = false;
      }
      return cached;
    },
    invalidate,
    dispose: unfollow,
  };
}
