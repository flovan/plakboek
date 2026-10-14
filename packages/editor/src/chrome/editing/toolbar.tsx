import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { toolbarPlacement, type Box } from '../../client/overlay/geometry.js';
import {
  legalityContextOf,
  catalogueByKey,
} from '../../client/session/move-action.js';
import {
  moveTargetReason,
  type MoveDirection,
} from '../../client/session/move-targets.js';
import { breadcrumb, selectCrumb } from '../../client/session/scope.js';
import { selectAndAnnounce } from '../../client/session/selection-announcement.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { labelOf, type ItemLabel } from '../../client/session/tree-model.js';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
} from '../icons.js';
import { formatString, STRINGS } from '../strings.js';
import { Tooltip } from '../tooltip.js';

/** The most crumbs shown; a longer path shows the first, "…", and the last two. */
const MAX_CRUMBS = 4;

const BUTTON =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent';

const CRUMB =
  'h-6 max-w-[96px] cursor-pointer truncate rounded-sm border-0 bg-transparent px-1 text-caption font-semibold text-text-muted hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-focus-ring';

function textOf(label: ItemLabel): string {
  return label.kind === 'column'
    ? formatString('label.column', { n: String(label.n) })
    : label.text;
}

type Crumb = { readonly id: string; readonly text: string };

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

export type ToolbarProps = {
  readonly store: EditorStore;
  /** The selected item's box in the shell's coordinates. */
  readonly item: Box;
  /** The frame's content box in the shell's coordinates. */
  readonly frame: Box;
  /** Whether the item's siblings sit side by side or stacked in the site. */
  readonly axis: 'horizontal' | 'vertical';
  readonly onMove: (id: string, direction: MoveDirection) => void;
};

/**
 * The floating toolbar of the selected item: the path to it as a breadcrumb
 * and the buttons that move it one step earlier or later. It is pinned to the
 * item in the interaction plane, and is one tab stop with arrow keys roving
 * between its buttons. A button that cannot act stays focusable
 * (`aria-disabled`) so its reason can be read.
 */
export function Toolbar(props: ToolbarProps): ReactElement | null {
  const { store, item, frame, axis, onMove } = props;
  const state = useEditorStore(store, (current) => current);
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 40 });
  const [active, setActive] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

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
  if (model === null || session === null || selectedId === null) return null;
  const selected = model.get(selectedId);
  if (selected === undefined) return null;

  const byKey = catalogueByKey(session.catalogue);
  const path: Crumb[] = breadcrumb(model, selectedId).map((node) => ({
    id: node.id,
    text: textOf(labelOf(model, byKey, node.id)),
  }));
  const itemLabel = path[path.length - 1]?.text ?? '';
  const collapsed = path.length > MAX_CRUMBS;
  const hidden = collapsed ? path.slice(1, path.length - 2) : [];
  const shown: readonly (Crumb | 'more')[] = collapsed
    ? [path[0], 'more', ...path.slice(-2)].filter(
        (entry): entry is Crumb | 'more' => entry !== undefined,
      )
    : path;

  const ctx = legalityContextOf(state);
  const reasonFor = (direction: MoveDirection): string | null => {
    if (ctx === null) return STRINGS['toolbar.reason.atStart'];
    const reason = moveTargetReason(ctx, selectedId, direction);
    if (reason === null) return null;
    return STRINGS[
      reason === 'atStart' ? 'toolbar.reason.atStart' : 'toolbar.reason.atEnd'
    ];
  };

  const placement = toolbarPlacement({ item, frame, toolbar: size });
  const keys = [
    ...shown.flatMap((entry) =>
      entry === 'more'
        ? ['more']
        : entry.id === selectedId
          ? []
          : [`crumb:${entry.id}`],
    ),
    'earlier',
    'later',
  ];
  const current = keys.includes(active) ? active : (keys[0] ?? '');

  const selectCrumbById = (id: string): void => {
    setMenuOpen(false);
    selectAndAnnounce(store, selectCrumb(model, id));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && menuOpen) {
      event.stopPropagation();
      setMenuOpen(false);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[data-roving]'),
    ];
    const at = items.findIndex((candidate) => candidate === event.target);
    if (at === -1) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (at + (event.key === 'ArrowRight' ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  const rove = (key: string) => ({
    'data-roving': key,
    tabIndex: current === key ? 0 : -1,
    onFocus: () => {
      setActive(key);
    },
  });

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

  return (
    <div
      ref={root}
      className="pk-toolbar"
      data-toolbar=""
      data-placement={placement.mode}
      role="toolbar"
      aria-label={formatString('toolbar.label', { label: itemLabel })}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      style={{
        left: placement.left,
        top: placement.top,
        maxWidth: Math.max(0, frame.width - 16),
      }}
    >
      <nav
        className="flex min-w-0 items-center gap-1 overflow-hidden px-1"
        aria-label={STRINGS['toolbar.breadcrumb']}
      >
        {shown.map((entry, index) => {
          const separator =
            index === 0 ? null : (
              <span aria-hidden="true" className="text-caption text-text-muted">
                ›
              </span>
            );
          if (entry === 'more') {
            return (
              <span key="more" className="relative flex items-center gap-1">
                {separator}
                <button
                  type="button"
                  className={CRUMB}
                  aria-label={STRINGS['toolbar.more.label']}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => {
                    setMenuOpen((open) => !open);
                  }}
                  {...rove('more')}
                >
                  {STRINGS['toolbar.more']}
                </button>
                {menuOpen ? (
                  <div
                    role="menu"
                    className="pk-toolbar-menu"
                    aria-label={STRINGS['toolbar.breadcrumb']}
                  >
                    {hidden.map((crumb) => (
                      <button
                        key={crumb.id}
                        type="button"
                        role="menuitem"
                        className={CRUMB}
                        onClick={() => {
                          selectCrumbById(crumb.id);
                        }}
                      >
                        {crumb.text}
                      </button>
                    ))}
                  </div>
                ) : null}
              </span>
            );
          }
          const last = entry.id === selectedId;
          return (
            <span key={entry.id} className="flex items-center gap-1">
              {separator}
              {last ? (
                <span
                  aria-current="true"
                  title={entry.text}
                  className="inline-block h-6 max-w-[96px] truncate px-1 text-caption leading-6 font-semibold text-text"
                >
                  {entry.text}
                </span>
              ) : (
                <button
                  type="button"
                  className={CRUMB}
                  title={entry.text}
                  aria-label={entry.text}
                  onClick={() => {
                    selectCrumbById(entry.id);
                  }}
                  {...rove(`crumb:${entry.id}`)}
                >
                  {entry.text}
                </button>
              )}
            </span>
          );
        })}
      </nav>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
      {moveButton('earlier')}
      {moveButton('later')}
    </div>
  );
}
