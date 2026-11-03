import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import {
  frameElementOf,
  frameOriginOf,
} from '../../client/chrome-host/shape.js';
import {
  toolbarPlacement,
  type Box,
  type Point,
} from '../../client/overlay/geometry.js';
import { legalityContextOf } from '../../client/session/move-action.js';
import {
  moveTargetReason,
  type MoveDirection,
} from '../../client/session/move-targets.js';
import { slotAfter, type InsertSlot } from '../../client/session/insertion.js';
import {
  canDuplicate,
  deleteBlockedReason,
} from '../../client/session/structure-actions.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  DuplicateIcon,
  GripIcon,
  PlusIcon,
  PropertiesIcon,
  TrashIcon,
} from '../icons.js';
import { formatString, STRINGS } from '../strings.js';
import { Tooltip } from '../tooltip.js';
import { Crumbs, crumbKeys, crumbLayout, useRoving } from './text/crumbs.js';

function boxStyle(box: Box): CSSProperties {
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

const BUTTON =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent';

/** Delete turns destructive on hover and focus only, and never while it cannot act. */
const DELETE_BUTTON = `${BUTTON} hover:text-destructive focus-visible:text-destructive`;

const MOVE_ICON = {
  vertical: { earlier: ArrowUpIcon, later: ArrowDownIcon },
  horizontal: { earlier: ArrowLeftIcon, later: ArrowRightIcon },
} as const;

const MOVE_COPY = {
  vertical: {
    earlier: ['toolbar.moveUp', 'toolbar.moveUp.label'],
    later: ['toolbar.moveDown', 'toolbar.moveDown.label'],
  },
  horizontal: {
    earlier: ['toolbar.moveLeft', 'toolbar.moveLeft.label'],
    later: ['toolbar.moveRight', 'toolbar.moveRight.label'],
  },
} as const;

/** The platform's shortcut key: Command on Apple systems, Control elsewhere. */
function shortcutModifier(): 'Meta' | 'Control' {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control';
}

export type ToolbarProps = {
  readonly store: EditorStore;
  /** The selected item's box in the framed document's coordinates. */
  readonly item: Box;
  /** The part of the document the frame shows, in the same coordinates. */
  readonly visible: Box;
  /** Whether the item's siblings sit side by side or stacked in the site. */
  readonly axis: 'horizontal' | 'vertical';
  readonly onMove: (id: string, direction: MoveDirection) => void;
  readonly onDuplicate: (id: string) => void;
  readonly onDelete: (id: string) => void;
  /** Called with the gap right after the selected item. */
  readonly onAddAfter: (slot: InsertSlot) => void;
  /** Called when the drag handle is pressed, with the press in the shell's coordinates: the pointer drag starts once it has moved 4px. */
  readonly onDragStart?: (id: string, origin: Point) => void;
  /** Called when Space or Enter on the drag handle lifts the item for a keyboard drag. */
  readonly onLiftDrag?: (id: string) => void;
};

/**
 * The floating toolbar of the selected item: the path to it as a breadcrumb
 * and the buttons that move it one step earlier or later, add after it (a
 * column adds a column), duplicate it or delete it. It is pinned to the
 * item in the interaction plane (in the framed document, so it scrolls with
 * the page), and is one tab stop with arrow keys roving between its buttons.
 * Where neither side has room it is pinned inside the item with
 * `position: sticky`, so it stays inside the visible top without a scroll
 * listener. A button that cannot act stays focusable
 * (`aria-disabled`) so its reason can be read.
 */
export function Toolbar(props: ToolbarProps): ReactElement | null {
  const {
    store,
    item,
    visible,
    axis,
    onMove,
    onDuplicate,
    onDelete,
    onAddAfter,
    onDragStart,
    onLiftDrag,
  } = props;
  const state = useEditorStore(store, (current) => current);
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 40 });

  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    setSize((previous) =>
      previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  });

  const { model, selection, session } = state;
  const selectedId = selection.selectedId;
  const selected =
    model === null || selectedId === null ? undefined : model.get(selectedId);
  const layout =
    model === null || session === null || selectedId === null
      ? null
      : crumbLayout(model, session, selectedId);
  const ctx = legalityContextOf(state);
  const addSlot =
    ctx === null || selectedId === null ? null : slotAfter(ctx, selectedId);
  const keys = [
    'drag',
    ...(layout === null || selectedId === null
      ? []
      : crumbKeys(layout, selectedId)),
    'earlier',
    'later',
    ...(addSlot === null ? [] : ['add']),
    'duplicate',
    ...(selected?.kind === 'column' ? [] : ['properties']),
    'delete',
  ];
  const { rove, onKeyDown } = useRoving(keys);
  if (
    model === null ||
    session === null ||
    selectedId === null ||
    selected === undefined ||
    layout === null
  ) {
    return null;
  }
  const itemLabel = layout.itemLabel;

  const reasonFor = (direction: MoveDirection): string | null => {
    if (ctx === null) return STRINGS['toolbar.reason.atStart'];
    const reason = moveTargetReason(ctx, selectedId, direction);
    if (reason === null) return null;
    return STRINGS[
      reason === 'atStart' ? 'toolbar.reason.atStart' : 'toolbar.reason.atEnd'
    ];
  };

  const placement = toolbarPlacement({ item, visible, toolbar: size });

  const moveButton = (direction: MoveDirection): ReactElement => {
    const reason = reasonFor(direction);
    const [tooltipKey, labelKey] = MOVE_COPY[axis][direction];
    const Icon = MOVE_ICON[axis][direction];
    return (
      <Tooltip
        label={reason ?? STRINGS[tooltipKey]}
        placement={placement.mode === 'below' ? 'top' : 'bottom'}
      >
        <button
          type="button"
          className={BUTTON}
          aria-label={formatString(labelKey, { label: itemLabel })}
          aria-disabled={reason !== null}
          onClick={() => {
            if (reason === null) onMove(selectedId, direction);
          }}
          {...rove(direction)}
        >
          <Icon />
        </button>
      </Tooltip>
    );
  };

  const onHandlePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
  ): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    // The press is in the frame document's viewport; the drag is the shell's.
    const frame = frameElementOf(event.currentTarget);
    const origin = frame === null ? { x: 0, y: 0 } : frameOriginOf(frame);
    onDragStart?.(selectedId, {
      x: event.clientX + origin.x,
      y: event.clientY + origin.y,
    });
  };
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) onLiftDrag?.(selectedId);
  };

  const duplicateReason =
    ctx !== null && canDuplicate(ctx, selectedId)
      ? null
      : STRINGS['toolbar.reason.noDuplicate'];
  const blocked = deleteBlockedReason(state, selectedId);
  const deleteReason = blocked === null ? null : STRINGS[blocked];

  const pinned = placement.mode === 'pinned';
  const maxWidth = Math.max(0, visible.width - 16);
  return (
    // The wrapper is always there so the toolbar keeps its place in the tree
    // (and its focus) when it changes side. Pinned, it spans the item and the
    // toolbar sticks inside it; otherwise it is a point at the origin the
    // toolbar's left and top are measured from.
    <div
      className="pk-toolbar-pin"
      data-pinned={pinned ? '' : undefined}
      style={pinned ? boxStyle(item) : undefined}
    >
      <div
        ref={root}
        className="pk-toolbar"
        data-toolbar=""
        data-placement={placement.mode}
        role="toolbar"
        aria-label={formatString('toolbar.label', { label: itemLabel })}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        style={
          pinned
            ? { maxWidth }
            : { left: placement.left, top: placement.top, maxWidth }
        }
      >
        <Tooltip
          label={STRINGS['toolbar.drag.tooltip']}
          placement={placement.mode === 'below' ? 'top' : 'bottom'}
        >
          <button
            type="button"
            className={`${BUTTON} cursor-grab touch-none select-none`}
            data-drag-handle=""
            aria-label={formatString('toolbar.drag.label', {
              label: itemLabel,
            })}
            onPointerDown={onHandlePointerDown}
            onKeyDown={onHandleKeyDown}
            {...rove('drag')}
          >
            <GripIcon />
          </button>
        </Tooltip>
        <Crumbs
          store={store}
          model={model}
          selectedId={selectedId}
          layout={layout}
          rove={rove}
        />
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
        {moveButton('earlier')}
        {moveButton('later')}
        {addSlot === null ? null : (
          <Tooltip
            label={STRINGS['toolbar.addAfter']}
            placement={placement.mode === 'below' ? 'top' : 'bottom'}
          >
            <button
              type="button"
              className={BUTTON}
              aria-label={formatString('toolbar.addAfter.label', {
                label: itemLabel,
              })}
              aria-haspopup="dialog"
              onClick={() => {
                onAddAfter(addSlot);
              }}
              {...rove('add')}
            >
              <PlusIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={duplicateReason ?? STRINGS['toolbar.duplicate']}
          placement={placement.mode === 'below' ? 'top' : 'bottom'}
        >
          <button
            type="button"
            className={BUTTON}
            aria-label={formatString('toolbar.duplicate.label', {
              label: itemLabel,
            })}
            aria-disabled={duplicateReason !== null}
            aria-keyshortcuts={`${shortcutModifier()}+D`}
            onClick={() => {
              if (duplicateReason === null) onDuplicate(selectedId);
            }}
            {...rove('duplicate')}
          >
            <DuplicateIcon />
          </button>
        </Tooltip>
        {selected.kind === 'column' ? null : (
          <Tooltip
            label={STRINGS['toolbar.properties']}
            placement={placement.mode === 'below' ? 'top' : 'bottom'}
          >
            <button
              type="button"
              className={BUTTON}
              aria-label={formatString('toolbar.properties.label', {
                label: itemLabel,
              })}
              onClick={() => {
                store.requestProperties(selectedId);
              }}
              {...rove('properties')}
            >
              <PropertiesIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={deleteReason ?? STRINGS['toolbar.delete']}
          placement={placement.mode === 'below' ? 'top' : 'bottom'}
        >
          <button
            type="button"
            className={deleteReason === null ? DELETE_BUTTON : BUTTON}
            aria-label={formatString('toolbar.delete.label', {
              label: itemLabel,
            })}
            aria-disabled={deleteReason !== null}
            aria-keyshortcuts="Delete"
            onClick={() => {
              if (deleteReason === null) onDelete(selectedId);
            }}
            {...rove('delete')}
          >
            <TrashIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
