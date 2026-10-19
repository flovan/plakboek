import { useMemo, type ReactElement } from 'react';
import { frameOriginOf } from '../chrome-host/shape.js';
import { useEditorStore, type EditorStore } from '../session/store.js';
import { DragLabel, DragSurface } from './drag-layer.js';
import type { Box } from './geometry.js';

/** The frame's content box in the shell's coordinates. */
function contentBoxOf(frame: HTMLIFrameElement): Box {
  const origin = frameOriginOf(frame);
  return {
    left: origin.x,
    top: origin.y,
    width: frame.clientWidth,
    height: frame.clientHeight,
  };
}

/**
 * The part of a drag that is anchored to the pointer, not to the page, and so
 * stays in the shell: the transparent capture surface over the frame (every
 * pointer event of a drag is then the shell's and none crosses the frame
 * boundary) and the label that follows the pointer. Neither is positioned
 * from a page element, so neither can lag behind a scroll.
 */
export function ShellDragLayer(props: {
  readonly store: EditorStore;
  readonly frame: HTMLIFrameElement | null;
}): ReactElement | null {
  const { store, frame } = props;
  const covering = useEditorStore(
    store,
    (state) => state.drag?.via === 'pointer' && state.drag.active,
  );
  // The layout cannot change under a drag, so the frame is measured when the
  // surface goes up.
  const box = useMemo(
    () => (covering && frame !== null ? contentBoxOf(frame) : null),
    [covering, frame],
  );
  return (
    <>
      {box === null ? null : <DragSurface store={store} frame={box} />}
      <DragLabel store={store} />
    </>
  );
}
