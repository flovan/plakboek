import {
  useEffect,
  useLayoutEffect,
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
import { frameElementOf } from '../chrome-host/shape.js';
import { rowLabel } from '../session/page-tree.js';
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
import { DragDecoration } from './drag-layer.js';
import {
  chipPlacement,
  isVisibleIn,
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
 * needs-input marker, what an open picker hangs from and the item Page
 * structure points at.
 */
function wantedIds(state: EditorState): readonly string[] {
  const { model, selection, picker, highlight } = state;
  if (model === null) return [];
  const ids = new Set<string>();
  if (highlight !== null) ids.add(highlight);
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

/** The frame the layer sits in: the one passed, else the one its document is shown in. */
function frameFor(
  layer: HTMLDivElement | null,
  frame: HTMLIFrameElement | null | undefined,
): HTMLIFrameElement | null {
  return frame ?? frameElementOf(layer);
}

/**
 * A label chip. Above or inside its outline it sits at a fixed place; once the
 * outline's top has scrolled out of the visible part it is drawn
 * `position: sticky` inside a wrapper over the outline, so it stays 4px below
 * the visible top as the page scrolls, with no script.
 */
function PlacedChip(props: {
  readonly outline: Box;
  readonly chip: ChipPlacement;
  readonly text: string;
  readonly marker: 'data-overlay-chip' | null;
}): ReactElement | null {
  const { outline, chip, text, marker } = props;
  if (chip.mode === 'hidden') return null;
  const attributes = marker === null ? {} : { [marker]: '' };
  if (chip.mode === 'sticky') {
    return (
      <div className="pk-overlay-pin" style={boxStyle(outline)}>
        <div
          className="pk-overlay-chip"
          data-placement="sticky"
          {...attributes}
        >
          {text}
        </div>
      </div>
    );
  }
  return (
    <div
      className="pk-overlay-chip"
      data-placement={chip.mode}
      style={{ left: chip.left, top: chip.top }}
      {...attributes}
    >
      {text}
    </div>
  );
}

/**
 * The overlay: a hover outline, a dashed outline for the section around it and
 * a label chip, plus the selected item's outline and the scope container's
 * dashed outline, drawn over the framed site.
 *
 * It is rendered (by the shell's React tree, through a portal) into the chrome
 * host's shadow root inside the framed document, so everything it draws is in
 * the page's own coordinate space and scrolls with the page natively. Boxes
 * are the document coordinates the trackers measured; a scroll changes none
 * of them. The decoration layer does not take part in pointer or keyboard
 * interaction (`pointer-events: none`, `aria-hidden`); hover is read from the
 * frame by the tracker.
 *
 * With an editor store the overlay follows the session: it draws only while
 * the page is being edited in Edit mode, the hover outlines what a click would
 * select at the current scope, and the selection comes from the store. Without
 * one it is the plain hover overlay.
 *
 * The frame is the one the layer's document is shown in, unless one is passed.
 * The pointer-anchored parts of a drag (the capture surface and the label)
 * are not here: they stay in the shell (`ShellDragLayer`).
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
  const [frameElement, setFrameElement] = useState<HTMLIFrameElement | null>(
    null,
  );
  useLayoutEffect(() => {
    setFrameElement(frameFor(layer.current, frame));
  }, [frame]);
  const [state, setState] = useState<HoverState | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [axis, setAxis] = useState<'horizontal' | 'vertical'>('vertical');
  const [measured, setMeasured] = useState<BoxesState | null>(null);
  const flash = useEditorStore(store ?? NO_STORE, (current) => current.flash);
  const selectedId = useEditorStore(
    store ?? NO_STORE,
    (current) => current.selection.selectedId,
  );
  const scopeId = useEditorStore(
    store ?? NO_STORE,
    (current) => current.selection.scopeId,
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
              const { model } = store.getState();
              return model === null
                ? (chain[0] ?? null)
                : hoverTarget(model, chain);
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
        next.picker !== previous.picker ||
        next.highlight !== previous.highlight
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
    drawn = {
      outline: state.element,
      section: state.section,
      chip: chipPlacement({ outline: state.element, visible: state.visible }),
    };
  }
  // The part of the document the frame showed when the boxes were measured.
  const visible = measured?.visible ?? state?.visible ?? selection?.visible;
  const placed: ReadonlyMap<string, Box> = useMemo(
    () => measured?.boxes ?? new Map(),
    [measured],
  );
  // An item fixed to the viewport sits in no gap, so the gaps and the picker ignore it.
  const inFlow = useMemo((): ReadonlyMap<string, Box> => {
    if (measured === null || measured.fixed.length === 0) return placed;
    const fixed = new Set(measured.fixed);
    return new Map([...placed].filter(([id]) => !fixed.has(id)));
  }, [measured, placed]);
  const picker = useEditorStore(store ?? NO_STORE, (current) => current.picker);
  const highlight = useEditorStore(
    store ?? NO_STORE,
    (current) => current.highlight,
  );
  const highlightModel = useEditorStore(
    store ?? NO_STORE,
    (current) => current.model,
  );
  const highlightSession = useEditorStore(
    store ?? NO_STORE,
    (current) => current.session,
  );
  // What Page structure points at: the item's box and a chip with its name,
  // drawn like the hover outline. An item the frame does not show draws nothing.
  const highlightBox =
    highlight === null || measured === null || pointerDragging
      ? null
      : (placed.get(highlight) ?? null);
  const highlighted =
    highlight === null ||
    highlightBox === null ||
    measured === null ||
    highlightModel === null ||
    !isVisibleIn(highlightBox, measured.visible)
      ? null
      : {
          id: highlight,
          outline: highlightBox,
          chip: chipPlacement({
            outline: highlightBox,
            visible: measured.visible,
          }),
          text: rowLabel(
            highlightModel,
            new Map(
              (highlightSession?.catalogue ?? []).map((entry) => [
                entry.key,
                entry,
              ]),
            ),
            highlight,
          ),
        };

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
    (drag === null && !isVisibleIn(selection.selected, selection.visible))
      ? null
      : selection.selected;
  const dragSource =
    drag === null ||
    drag.subject.id !== selectedId ||
    selection === null ||
    selection.selected === null
      ? null
      : selection.selected;

  return (
    <>
      <div
        ref={layer}
        className="pk-overlay"
        aria-hidden="true"
        data-overlay=""
      >
        {visible === undefined ? null : (
          <div className="pk-overlay-plane">
            {selection === null || selection.scope === null ? null : (
              <div
                className="pk-overlay-scope"
                data-overlay-scope={scopeId ?? ''}
                style={boxStyle(selection.scope)}
              />
            )}
            {selection === null || selection.selected === null ? null : (
              <div
                className="pk-overlay-selected"
                data-overlay-selected={selectedId ?? ''}
                style={boxStyle(selection.selected)}
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
                style={boxStyle(selection.selected)}
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
                  <PlacedChip
                    outline={drawn.outline}
                    chip={drawn.chip}
                    text={chipText(state)}
                    marker="data-overlay-chip"
                  />
                </div>
              </>
            )}
            {highlighted === null ? null : (
              <div
                key={highlighted.id}
                className="pk-overlay-target"
                data-overlay-highlight={highlighted.id}
              >
                <div
                  className="pk-overlay-outline"
                  style={boxStyle(highlighted.outline)}
                />
                <PlacedChip
                  outline={highlighted.outline}
                  chip={highlighted.chip}
                  text={highlighted.text}
                  marker={null}
                />
              </div>
            )}
            {store === undefined ? null : (
              <DragDecoration
                store={store}
                view={frameElement?.contentWindow ?? null}
                source={dragSource}
              />
            )}
          </div>
        )}
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
      visible === undefined ? null : (
        <div className="pk-overlay-interaction" data-overlay-interaction="">
          <div className="pk-overlay-plane">
            {measured === null ? null : (
              <NeedsInputMarkers store={store} boxes={placed} />
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
                  visible={measured.visible}
                  onOpen={onOpenPicker}
                />
              </>
            )}
            {toolbarItem === null ? null : (
              <Toolbar
                store={store}
                item={toolbarItem}
                visible={selection?.visible ?? visible}
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
                anchor={slotAnchor(picker.slot, inFlow, visible)}
                visible={visible}
                onPick={onPick}
                onClose={onClosePicker}
                onDismiss={onDismissPicker}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
