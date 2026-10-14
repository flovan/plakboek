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
  /** The scene, read again only after the frame scrolled or resized or the model changed. */
  readonly read: () => DragScene | null;
  /** Forces the next `read` to measure again. */
  readonly invalidate: () => void;
  readonly dispose: () => void;
};

/** Follows the frame's scrolling so a drag measures once per change, not once per pointer move. */
export function createSceneReader(
  frame: HTMLIFrameElement,
  model: () => TreeModel | null,
): SceneReader {
  let cached: DragScene | null = null;
  let dirty = true;
  const view = frame.contentWindow;
  const invalidate = (): void => {
    dirty = true;
  };
  view?.addEventListener('scroll', invalidate, { passive: true });
  view?.addEventListener('resize', invalidate, { passive: true });
  return {
    read: () => {
      const current = model();
      if (current === null) return null;
      if (dirty || cached === null || cached.model !== current) {
        cached = readScene(frame, current);
        dirty = false;
      }
      return cached;
    },
    invalidate,
    dispose: () => {
      view?.removeEventListener('scroll', invalidate);
      view?.removeEventListener('resize', invalidate);
    },
  };
}
