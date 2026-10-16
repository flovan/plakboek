/**
 * The pointer drag, for the toolbar's handle and the palette's rows.
 *
 * A press on a source only becomes a drag after the pointer has moved 4px, so a
 * click never starts one. From then on the shell covers the frame with a
 * transparent capture surface and every pointer event is a shell event: the
 * drag never depends on events crossing the iframe boundary, and the site never
 * sees a press, move or release while it runs. The controller turns the shell's
 * pointer position into the frame's, asks which blocks lie under it, resolves
 * the slot once per animation frame, and scrolls the frame window itself when
 * the pointer is within 48px of its top or bottom edge. It listens on the shell's
 * window so a release anywhere ends the drag, and it always ends it (the caller
 * unmounts the surface in `onEnd`).
 */
import type { EditPosition } from '../../api-types.js';
import { hitChain } from '../frame/hit-test.js';
import type { Point } from '../overlay/geometry.js';
import type { LegalityContext } from '../session/legality.js';
import type { DragScene } from './scene.js';
import { resolveDropSlot, type DragSubject, type DropSlot } from './slots.js';

/** How far the pointer must move before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;

/** How near the frame's top or bottom edge the frame starts to scroll, and its fastest step per frame. */
export const EDGE_ZONE = 48;
export const MAX_SCROLL_STEP = 16;

/**
 * How far the frame scrolls this frame for a pointer at `y` in a frame of
 * `height`: negative near the top, positive near the bottom, fastest at the
 * edge and none outside the zones.
 */
export function autoScrollStep(y: number, height: number): number {
  if (y < EDGE_ZONE) {
    return -Math.round(
      MAX_SCROLL_STEP * Math.min(1, (EDGE_ZONE - y) / EDGE_ZONE),
    );
  }
  if (y > height - EDGE_ZONE) {
    return Math.round(
      MAX_SCROLL_STEP * Math.min(1, (y - (height - EDGE_ZONE)) / EDGE_ZONE),
    );
  }
  return 0;
}

export type PointerDragUpdate = {
  /** The pointer in the shell's coordinates. */
  readonly pointer: Point;
  /** The slot under it, null where nothing may land or outside the frame. */
  readonly slot: DropSlot | null;
  readonly inside: boolean;
};

export type PointerDragOptions = {
  readonly subject: DragSubject;
  readonly ctx: () => LegalityContext | null;
  readonly sceneOf: () => DragScene | null;
  readonly frame: HTMLIFrameElement;
  /** Where the press happened, in the shell's coordinates. */
  readonly origin: Point;
  /** The pointer has moved 4px: the drag is on. */
  readonly onActivate: () => void;
  /** Called once per frame in which the pointer, the slot or the frame's scroll changed. */
  readonly onUpdate: (update: PointerDragUpdate) => void;
  readonly onDrop: (position: EditPosition) => void;
  readonly onCancel: () => void;
  /** Always called last, after a drop, a cancel or a release before the threshold. */
  readonly onEnd: () => void;
};

type FrameBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

function contentBoxOf(frame: HTMLIFrameElement): FrameBox {
  const rect = frame.getBoundingClientRect();
  return {
    left: rect.left + frame.clientLeft,
    top: rect.top + frame.clientTop,
    width: frame.clientWidth,
    height: frame.clientHeight,
  };
}

/** Starts watching a press at `origin`; returns the function that abandons it. */
export function startPointerDrag(options: PointerDragOptions): () => void {
  const { frame, subject, origin } = options;
  const shell = frame.ownerDocument.defaultView;
  if (shell === null) {
    options.onEnd();
    return () => undefined;
  }
  const view = shell;
  let pointer: Point = origin;
  let active = false;
  let ended = false;
  let animation = 0;
  let lastScene: DragScene | null = null;
  let lastPointer: Point | null = null;

  /** The slot under a shell position, and whether it is inside the frame. */
  function resolve(
    at: Point,
    scene: DragScene | null,
  ): { slot: DropSlot | null; inside: boolean } {
    const box = contentBoxOf(frame);
    const x = at.x - box.left;
    const y = at.y - box.top;
    const inside = x >= 0 && y >= 0 && x <= box.width && y <= box.height;
    const ctx = options.ctx();
    const doc = frame.contentDocument;
    if (!inside || ctx === null || scene === null || doc === null) {
      return { slot: null, inside };
    }
    const chain = hitChain(doc, x, y, { ghosts: false });
    return {
      slot: resolveDropSlot(ctx, scene, subject, { x, y }, chain),
      inside,
    };
  }

  function tick(): void {
    animation = 0;
    if (ended || !active) return;
    // The scene and the slot describe the frame as it is painted now; a scroll
    // applied below shows up in the next frame's scene, so the line never lags
    // behind what is on screen.
    const scene = options.sceneOf();
    if (
      scene !== lastScene ||
      lastPointer === null ||
      lastPointer.x !== pointer.x ||
      lastPointer.y !== pointer.y
    ) {
      const found = resolve(pointer, scene);
      lastScene = scene;
      lastPointer = pointer;
      options.onUpdate({ pointer, slot: found.slot, inside: found.inside });
    }
    const box = contentBoxOf(frame);
    const y = pointer.y - box.top;
    const insideX = pointer.x >= box.left && pointer.x <= box.left + box.width;
    if (insideX && y >= 0 && y <= box.height) {
      const step = autoScrollStep(y, box.height);
      if (step !== 0)
        frame.contentWindow?.scrollBy({ top: step, behavior: 'instant' });
    }
    animation = view.requestAnimationFrame(tick);
  }

  const swallowClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    view.removeEventListener('click', swallowClick, true);
  };

  function finish(): void {
    if (ended) return;
    ended = true;
    view.removeEventListener('pointermove', onMove, true);
    view.removeEventListener('pointerup', onUp, true);
    view.removeEventListener('pointercancel', onCancel, true);
    view.removeEventListener('keydown', onKey, true);
    view.removeEventListener('selectstart', onSelect, true);
    if (animation !== 0) view.cancelAnimationFrame(animation);
    animation = 0;
    if (active) {
      // The release can still click the row it started on; that click is not an action.
      view.addEventListener('click', swallowClick, true);
      view.setTimeout(() => {
        view.removeEventListener('click', swallowClick, true);
      }, 0);
    }
    options.onEnd();
  }

  function onMove(event: PointerEvent): void {
    pointer = { x: event.clientX, y: event.clientY };
    if (active) return;
    if (
      Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < DRAG_THRESHOLD
    ) {
      return;
    }
    active = true;
    options.onActivate();
    animation = view.requestAnimationFrame(tick);
  }

  function onUp(event: PointerEvent): void {
    if (!active) {
      finish();
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    // What is under the release, not what the last frame showed.
    const found = resolve(pointer, options.sceneOf());
    if (found.inside && found.slot !== null) {
      options.onDrop(found.slot.position);
    } else {
      options.onCancel();
    }
    finish();
  }

  function onCancel(): void {
    if (active) options.onCancel();
    finish();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (!active) {
      finish();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    options.onCancel();
    finish();
  }

  function onSelect(event: Event): void {
    if (active) event.preventDefault();
  }

  view.addEventListener('pointermove', onMove, true);
  view.addEventListener('pointerup', onUp, true);
  view.addEventListener('pointercancel', onCancel, true);
  view.addEventListener('keydown', onKey, true);
  view.addEventListener('selectstart', onSelect, true);

  return () => {
    if (ended) return;
    if (active) options.onCancel();
    finish();
  };
}
