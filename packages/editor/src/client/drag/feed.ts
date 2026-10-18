/**
 * What the overlay draws while an item is dragged, kept apart from the
 * session store. The pointer and the line change on every animation frame,
 * and a store update would re-render everything that reads the session; this
 * small channel is read only by the drag visuals.
 */
import { sameBox, type Box, type Point } from '../overlay/geometry.js';

export type DragFeedState = {
  /** The pointer in the shell's coordinates, null for a keyboard drag. */
  readonly pointer: Point | null;
  /** The insertion line in the frame's coordinates, null where nothing may land. */
  readonly line: Box | null;
  /** The direction the line runs. */
  readonly axis: 'horizontal' | 'vertical' | null;
};

export const EMPTY_FEED: DragFeedState = {
  pointer: null,
  line: null,
  axis: null,
};

export type DragFeed = {
  get(): DragFeedState;
  set(next: DragFeedState): void;
  subscribe(listener: () => void): () => void;
};

function samePoint(a: Point | null, b: Point | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}

export function createDragFeed(): DragFeed {
  let state = EMPTY_FEED;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (
        samePoint(state.pointer, next.pointer) &&
        sameBox(state.line, next.line) &&
        state.axis === next.axis
      ) {
        return;
      }
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
