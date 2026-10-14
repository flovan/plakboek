import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { Toolbar } from '../../chrome/editing/toolbar.js';
import { formatString } from '../../chrome/strings.js';
import { measureSiblingAxis } from '../frame/sibling-axis.js';
import type { MoveDirection } from '../session/move-targets.js';
import { hoverTarget } from '../session/scope.js';
import {
  NO_STORE,
  useEditorStore,
  type EditorStore,
} from '../session/store.js';
import {
  chipPlacement,
  isVisibleIn,
  outlineRect,
  type Box,
  type ChipPlacement,
} from './geometry.js';
import {
  createHoverTracker,
  type HoverState,
  type SelectionState,
} from './tracker.js';

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
  /** Called by the toolbar's move buttons. */
  readonly onMove?: (id: string, direction: MoveDirection) => void;
  /** Called by the toolbar's Duplicate and Delete buttons. */
  readonly onDuplicate?: (id: string) => void;
  readonly onDelete?: (id: string) => void;
}): ReactElement {
  const { frame, store, onMove, onDuplicate, onDelete } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HoverState | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [axis, setAxis] = useState<'horizontal' | 'vertical'>('vertical');
  const flash = useEditorStore(store ?? NO_STORE, (current) => current.flash);
  const selectedId = useEditorStore(
    store ?? NO_STORE,
    (current) => current.selection.selectedId,
  );
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
              onChange: (next) => {
                setSelection(next);
                const { model, selection: current } = store.getState();
                const frameDocument = target.contentDocument;
                const node =
                  current.selectedId === null || model === null
                    ? undefined
                    : model.get(current.selectedId);
                if (
                  node === undefined ||
                  model === null ||
                  frameDocument === null
                ) {
                  return;
                }
                setAxis(
                  measureSiblingAxis(
                    frameDocument,
                    model
                      .childrenOf(node.parentId)
                      .map((sibling) => sibling.id),
                  ),
                );
              },
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

  // The toolbar gives way to the delete confirmation while it is open.
  const confirming = useEditorStore(
    store ?? NO_STORE,
    (current) => current.deleteRequest !== null,
  );
  const toolbarItem =
    store === undefined ||
    confirming ||
    selection === null ||
    selection.selected === null ||
    selectedId === null ||
    origin === null ||
    !isVisibleIn(outlineRect(selection.selected, origin), selection.frame)
      ? null
      : outlineRect(selection.selected, origin);

  return (
    <>
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
            {selection === null ||
            selection.selected === null ||
            flash === null ||
            flash.id !== selectedId ? null : (
              <div
                key={flash.token}
                className="pk-overlay-flash"
                data-overlay-flash=""
                style={boxStyle(outlineRect(selection.selected, origin))}
                onAnimationEnd={() => {
                  store?.clearFlash();
                }}
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
      {store === undefined ||
      onMove === undefined ||
      onDuplicate === undefined ||
      onDelete === undefined ||
      !active ||
      frameBox === null ||
      toolbarItem === null ? null : (
        <div
          className="pk-overlay-interaction"
          data-overlay-interaction=""
          style={boxStyle(frameBox)}
        >
          <div
            className="pk-overlay-plane"
            style={{ left: -frameBox.left, top: -frameBox.top }}
          >
            <Toolbar
              store={store}
              item={toolbarItem}
              frame={frameBox}
              axis={axis}
              onMove={onMove}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
            />
          </div>
        </div>
      )}
    </>
  );
}
