import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { formatString } from '../../chrome/strings.js';
import { hoverTarget } from '../session/scope.js';
import {
  createEditorStore,
  useEditorStore,
  type EditorStore,
} from '../session/store.js';
import {
  chipPlacement,
  outlineRect,
  type Box,
  type ChipPlacement,
} from './geometry.js';
import {
  createHoverTracker,
  type HoverState,
  type SelectionState,
} from './tracker.js';

/** Stands in for the store when the overlay has none, so the hook still runs. */
const NO_STORE = createEditorStore();

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

/** The chip's text: the editor label, with " (unavailable)" after it for a
 * block that renders nothing. */
export function chipText(state: {
  readonly label: string;
  readonly unavailable: boolean;
}): string {
  return state.unavailable
    ? formatString('overlay.unavailable', { type: state.label })
    : state.label;
}

/**
 * The overlay: a hover outline, a dashed outline for the section around it and
 * a label chip, plus the selected item's outline and the scope container's
 * dashed outline, drawn over the framed site.
 *
 * It is a layer of the shell, exactly over the frame's content box and
 * clipped to it, so everything it draws lives in the shell's shadow root and
 * the site's document is never touched. The layer does not take part in
 * pointer or keyboard interaction (`pointer-events: none`, `aria-hidden`);
 * hover is read from the frame by the tracker. Inside the clip, an
 * unclipped plane starts at the shell's origin, so boxes are placed with the
 * shell's own coordinates.
 *
 * With an editor store the overlay follows the session: it draws only while
 * the page is being edited in Edit mode, the hover outlines what a click would
 * select at the current scope, and the selection comes from the store. Without
 * one it is the plain hover overlay.
 *
 * The frame is looked up in the shadow root the layer sits in, unless one is
 * passed.
 */
export function OverlayLayer(props: {
  readonly frame?: HTMLIFrameElement | null;
  readonly store?: EditorStore;
}): ReactElement {
  const { frame, store } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HoverState | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const active = useEditorStore(
    store ?? NO_STORE,
    (current) =>
      store === undefined ||
      (current.status === 'editing' && current.mode === 'edit'),
  );

  useEffect(() => {
    if (!active) {
      setState(null);
      setSelection(null);
      return undefined;
    }
    const root = layer.current?.getRootNode();
    const target =
      frame ??
      (root instanceof ShadowRoot || root instanceof Document
        ? root.querySelector('iframe')
        : null);
    if (!(target instanceof HTMLIFrameElement)) return undefined;
    const created = createHoverTracker(
      target,
      setState,
      store === undefined
        ? {}
        : {
            resolve: (chain) => {
              const { model, selection: scope } = store.getState();
              return model === null
                ? (chain[0] ?? null)
                : hoverTarget(model, scope, chain);
            },
            selection: {
              read: () => store.getState().selection,
              onChange: setSelection,
            },
          },
    );
    // A new selection changes what a click would select under the pointer.
    let previous = store?.getState().selection;
    const unsubscribe = store?.subscribe(() => {
      const next = store.getState().selection;
      if (next === previous) return;
      previous = next;
      created.refresh();
    });
    return () => {
      unsubscribe?.();
      created.dispose();
    };
  }, [frame, store, active]);

  let drawn: {
    readonly outline: Box;
    readonly section: Box | null;
    readonly chip: ChipPlacement;
  } | null = null;
  if (state !== null) {
    const origin = { x: state.frame.left, y: state.frame.top };
    const outline = outlineRect(state.element, origin);
    drawn = {
      outline,
      section:
        state.section === null ? null : outlineRect(state.section, origin),
      chip: chipPlacement({ outline, frame: state.frame }),
    };
  }
  const frameBox = state?.frame ?? selection?.frame ?? null;
  const origin =
    frameBox === null ? null : { x: frameBox.left, y: frameBox.top };

  return (
    <div
      ref={layer}
      className="pk-overlay"
      aria-hidden="true"
      data-overlay=""
      style={frameBox === null ? undefined : boxStyle(frameBox)}
    >
      {frameBox !== null && origin !== null ? (
        <div
          className="pk-overlay-plane"
          style={{ left: -frameBox.left, top: -frameBox.top }}
        >
          {selection === null || selection.scope === null ? null : (
            <div
              className="pk-overlay-scope"
              data-overlay-scope=""
              style={boxStyle(outlineRect(selection.scope, origin))}
            />
          )}
          {selection === null || selection.selected === null ? null : (
            <div
              className="pk-overlay-selected"
              data-overlay-selected=""
              style={boxStyle(outlineRect(selection.selected, origin))}
            />
          )}
          {drawn === null || state === null ? null : (
            <>
              {drawn.section === null ? null : (
                <div
                  className="pk-overlay-section"
                  data-overlay-section=""
                  style={boxStyle(drawn.section)}
                />
              )}
              <div
                key={state.blockId}
                className="pk-overlay-target"
                data-overlay-target={state.blockId}
              >
                <div
                  className="pk-overlay-outline"
                  data-overlay-outline=""
                  style={boxStyle(drawn.outline)}
                />
                {drawn.chip.mode === 'hidden' ? null : (
                  <div
                    className="pk-overlay-chip"
                    data-overlay-chip=""
                    data-placement={drawn.chip.mode}
                    style={{ left: drawn.chip.left, top: drawn.chip.top }}
                  >
                    {chipText(state)}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
