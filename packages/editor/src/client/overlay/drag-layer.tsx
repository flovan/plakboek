import {
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { DragFeedState } from '../drag/feed.js';
import { useEditorStore, type EditorStore } from '../session/store.js';
import { outlineRect, type Box } from './geometry.js';

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

/** What the pointer and the line are now; read by the drag visuals only. */
function useDragFeed(store: EditorStore): DragFeedState {
  return useSyncExternalStore(
    (listener) => store.dragFeed.subscribe(listener),
    () => store.dragFeed.get(),
    () => store.dragFeed.get(),
  );
}

/**
 * What a drag draws in the decoration plane: the dim over the item being moved
 * and the insertion line at the slot the drop would use. Both are in the
 * shell's coordinates; the line comes in the frame's.
 */
export function DragDecoration(props: {
  readonly store: EditorStore;
  /** The frame's content box in the shell's coordinates. */
  readonly frame: Box;
  /** The dragged item's box in the shell's coordinates, none for a new block. */
  readonly source: Box | null;
}): ReactElement | null {
  const { store, frame, source } = props;
  const dragging = useEditorStore(store, (state) => state.drag !== null);
  const feed = useDragFeed(store);
  if (!dragging) return null;
  const line =
    feed.line === null
      ? null
      : outlineRect(feed.line, { x: frame.left, y: frame.top });
  return (
    <>
      {source === null ? null : (
        <div
          className="pk-overlay-drag-source"
          data-drag-source=""
          style={boxStyle(source)}
        />
      )}
      {line === null ? null : (
        <div
          className="pk-drag-line"
          data-drag-line=""
          data-axis={feed.axis ?? 'horizontal'}
          style={boxStyle(line)}
        />
      )}
    </>
  );
}

/**
 * The transparent surface over the frame while a pointer drag runs, so every
 * pointer event is the shell's and none depends on the frame boundary. Its
 * cursor says whether a drop here would do anything.
 */
export function DragSurface(props: {
  readonly store: EditorStore;
  readonly frame: Box;
}): ReactElement | null {
  const { store, frame } = props;
  const covering = useEditorStore(
    store,
    (state) => state.drag?.via === 'pointer' && state.drag.active,
  );
  const feed = useDragFeed(store);
  if (!covering) return null;
  return (
    <div
      className="pk-drag-surface"
      data-drag-surface=""
      data-legal={feed.line !== null}
      style={boxStyle(frame)}
    />
  );
}

/** The chip that follows the pointer: 12px right of it and 12px below. */
export function DragLabel(props: {
  readonly store: EditorStore;
}): ReactElement | null {
  const { store } = props;
  const label = useEditorStore(store, (state) =>
    state.drag?.via === 'pointer' && state.drag.active
      ? state.drag.label
      : null,
  );
  const feed = useDragFeed(store);
  if (label === null || feed.pointer === null) return null;
  return (
    <div
      className="pk-drag-label"
      data-drag-label=""
      style={{ left: feed.pointer.x + 12, top: feed.pointer.y + 12 }}
    >
      {label}
    </div>
  );
}
