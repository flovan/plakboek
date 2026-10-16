import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { CatalogueEntry } from '../../api-types.js';
import { EmptyPrompts } from '../../chrome/editing/empty-prompts.js';
import { InsertPoints } from '../../chrome/editing/insert-points.js';
import { NeedsInputMarkers } from '../../chrome/editing/needs-input.js';
import { Picker } from '../../chrome/editing/picker.js';
import { Toolbar } from '../../chrome/editing/toolbar.js';
import { formatString } from '../../chrome/strings.js';
import { measureSiblingAxis } from '../frame/sibling-axis.js';
import type { InsertSlot } from '../session/insertion.js';
import type { MoveDirection } from '../session/move-targets.js';
import { hoverTarget } from '../session/scope.js';
import {
  NO_STORE,
  useEditorStore,
  type EditorState,
  type EditorStore,
  type PickerOpener,
} from '../session/store.js';
import { createBoxTracker, type BoxesState } from './boxes.js';
import { DragDecoration, DragLabel, DragSurface } from './drag-layer.js';
import {
  chipPlacement,
  isVisibleIn,
  outlineRect,
  type Box,
  type ChipPlacement,
  type Point,
} from './geometry.js';
import { slotAnchor } from './slot-geometry.js';
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
 * The ids whose boxes the overlay needs: the children of the scope (the gaps
 * between them are the insert points) and their parent, the columns of a
 * selected section (the gaps between them add a column), the blocks that show a
 * needs-input marker, and what an open picker hangs from.
 */
function wantedIds(state: EditorState): readonly string[] {
  const { model, selection, picker } = state;
  if (model === null) return [];
  const ids = new Set<string>();
  const addLevel = (parentId: string | null): void => {
    if (parentId !== null) ids.add(parentId);
    for (const child of model.childrenOf(parentId)) ids.add(child.id);
  };
  addLevel(selection.scopeId);
  // The lines between the columns of a selected section hang from its columns.
  if (selection.selectedId !== null) {
    if (model.get(selection.selectedId)?.kind === 'section') {
      addLevel(selection.selectedId);
    }
  }
  if (picker !== null) addLevel(picker.slot.parentId);
  for (const node of model.documentOrder()) {
    if (node.needsInput.length > 0) ids.add(node.id);
  }
  return [...ids];
}

/** The frame the layer sits over: the one passed, else the one in its own root. */
function frameFor(
  layer: HTMLDivElement | null,
  frame: HTMLIFrameElement | null | undefined,
): HTMLIFrameElement | null {
  const root = layer?.getRootNode();
  const target =
    frame ??
    (root instanceof ShadowRoot || root instanceof Document
      ? root.querySelector('iframe')
      : null);
  return target instanceof HTMLIFrameElement ? target : null;
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
  /** Called by an insert point, an empty prompt and the toolbar's Add after. */
  readonly onOpenPicker?: (slot: InsertSlot, opener: PickerOpener) => void;
  /** Called when the picker's Escape closes it. */
  readonly onClosePicker?: () => void;
  /** Called when a press or focus elsewhere closes the picker. */
  readonly onDismissPicker?: () => void;
  /** Called when a type is chosen in the picker. */
  readonly onPick?: (entry: CatalogueEntry) => void;
  /** Called when the toolbar's drag handle is pressed, with where the press was. */
  readonly onDragStart?: (id: string, origin: Point) => void;
  /** Called when Space or Enter on the drag handle lifts the item. */
  readonly onLiftDrag?: (id: string) => void;
}): ReactElement {
  const {
    frame,
    store,
    onMove,
    onDuplicate,
    onDelete,
    onOpenPicker,
    onClosePicker,
    onDismissPicker,
    onPick,
    onDragStart,
    onLiftDrag,
  } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HoverState | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [axis, setAxis] = useState<'horizontal' | 'vertical'>('vertical');
  const [measured, setMeasured] = useState<BoxesState | null>(null);
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
  const drag = useEditorStore(store ?? NO_STORE, (current) => current.drag);
  // While the pointer drags, the frame belongs to the drag: no hover, toolbar or gaps.
  const pointerDragging = drag?.via === 'pointer' && drag.active;

  useEffect(() => {
    if (!active) {
      setState(null);
      setSelection(null);
      return undefined;
    }
    const target = frameFor(layer.current, frame);
    if (target === null) return undefined;
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
    // A new selection changes what a click would select under the pointer, and
    // so does a saved write, which patches the markup under it.
    let previous = store?.getState();
    const unsubscribe = store?.subscribe(() => {
      const next = store.getState();
      const changed =
        next.selection !== previous?.selection || next.model !== previous.model;
      previous = next;
      if (changed) created.refresh();
    });
    return () => {
      unsubscribe?.();
      created.dispose();
    };
  }, [frame, store, active]);

  // The boxes of the items the gaps, prompts and markers are drawn from.
  useEffect(() => {
    if (!active || store === undefined) {
      setMeasured(null);
      return undefined;
    }
    const target = frameFor(layer.current, frame);
    if (target === null) return undefined;
    const tracker = createBoxTracker(target, {
      ids: () => wantedIds(store.getState()),
      onChange: setMeasured,
    });
    let previous = store.getState();
    const unsubscribe = store.subscribe(() => {
      const next = store.getState();
      if (
        next.selection !== previous.selection ||
        next.model !== previous.model ||
        next.picker !== previous.picker
      ) {
        tracker.refresh();
      }
      previous = next;
    });
    return () => {
      unsubscribe();
      tracker.dispose();
    };
  }, [frame, store, active]);

  let drawn: {
    readonly outline: Box;
    readonly section: Box | null;
    readonly chip: ChipPlacement;
  } | null = null;
  if (state !== null && !pointerDragging) {
    const origin = { x: state.frame.left, y: state.frame.top };
    const outline = outlineRect(state.element, origin);
    drawn = {
      outline,
      section:
        state.section === null ? null : outlineRect(state.section, origin),
      chip: chipPlacement({ outline, frame: state.frame }),
    };
  }
  const frameBox = measured?.frame ?? state?.frame ?? selection?.frame ?? null;
  const origin =
    frameBox === null ? null : { x: frameBox.left, y: frameBox.top };
  const placed = useMemo((): ReadonlyMap<string, Box> => {
    if (measured === null) return new Map();
    const at = { x: measured.frame.left, y: measured.frame.top };
    return new Map(
      [...measured.boxes].map(([id, box]) => [id, outlineRect(box, at)]),
    );
  }, [measured]);
  // An item fixed to the viewport sits in no gap, so the gaps and the picker ignore it.
  const inFlow = useMemo((): ReadonlyMap<string, Box> => {
    if (measured === null || measured.fixed.length === 0) return placed;
    const fixed = new Set(measured.fixed);
    return new Map([...placed].filter(([id]) => !fixed.has(id)));
  }, [measured, placed]);
  const picker = useEditorStore(store ?? NO_STORE, (current) => current.picker);

  // The toolbar gives way to the delete confirmation while it is open.
  const confirming = useEditorStore(
    store ?? NO_STORE,
    (current) => current.deleteRequest !== null,
  );
  // A keyboard drag keeps the toolbar (it holds the focused handle) even when
  // the frame has scrolled the item out of view.
  const toolbarItem =
    store === undefined ||
    confirming ||
    pointerDragging ||
    selection === null ||
    selection.selected === null ||
    selectedId === null ||
    origin === null ||
    (drag === null &&
      !isVisibleIn(outlineRect(selection.selected, origin), selection.frame))
      ? null
      : outlineRect(selection.selected, origin);
  const dragSource =
    drag === null ||
    drag.subject.kind !== 'move' ||
    drag.subject.id !== selectedId ||
    selection === null ||
    selection.selected === null ||
    origin === null
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
            {store === undefined || origin === null ? null : (
              <DragDecoration
                store={store}
                frame={frameBox}
                source={dragSource}
              />
            )}
          </div>
        ) : null}
      </div>
      {store === undefined ||
      onMove === undefined ||
      onDuplicate === undefined ||
      onDelete === undefined ||
      onOpenPicker === undefined ||
      onClosePicker === undefined ||
      onDismissPicker === undefined ||
      onPick === undefined ||
      !active ||
      frameBox === null ? null : (
        <div
          className="pk-overlay-interaction"
          data-overlay-interaction=""
          style={boxStyle(frameBox)}
        >
          <div
            className="pk-overlay-plane"
            style={{ left: -frameBox.left, top: -frameBox.top }}
          >
            <DragSurface store={store} frame={frameBox} />
            {measured === null ? null : (
              <NeedsInputMarkers
                store={store}
                boxes={placed}
                frame={measured.frame}
              />
            )}
            {confirming || measured === null || drag !== null ? null : (
              <>
                <InsertPoints
                  store={store}
                  boxes={inFlow}
                  onOpen={(slot) => {
                    onOpenPicker(slot, 'insert-point');
                  }}
                />
                <EmptyPrompts
                  store={store}
                  empty={measured.empty}
                  boxes={placed}
                  frame={measured.frame}
                  onOpen={onOpenPicker}
                />
              </>
            )}
            {toolbarItem === null ? null : (
              <Toolbar
                store={store}
                item={toolbarItem}
                frame={frameBox}
                axis={axis}
                onMove={onMove}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
                onAddAfter={(slot) => {
                  onOpenPicker(slot, 'toolbar');
                }}
                onDragStart={onDragStart}
                onLiftDrag={onLiftDrag}
              />
            )}
            {picker === null || confirming || drag !== null ? null : (
              <Picker
                key={picker.token}
                store={store}
                slot={picker.slot}
                anchor={slotAnchor(picker.slot, inFlow, frameBox)}
                frame={frameBox}
                onPick={onPick}
                onClose={onClosePicker}
                onDismiss={onDismissPicker}
              />
            )}
          </div>
        </div>
      )}
      {store === undefined ? null : <DragLabel store={store} />}
    </>
  );
}
