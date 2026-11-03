import {
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { isNodeLike } from '../../../client/chrome-host/shape.js';
import { catalogueByKey } from '../../../client/session/move-action.js';
import { breadcrumb, selectCrumb } from '../../../client/session/scope.js';
import { selectAndAnnounce } from '../../../client/session/selection-announcement.js';
import type { EditorStore } from '../../../client/session/store.js';
import {
  labelOf,
  type ItemLabel,
  type TreeModel,
} from '../../../client/session/tree-model.js';
import type { EditorSession } from '../../../api-types.js';
import { formatString, STRINGS } from '../../strings.js';

/** The most crumbs shown; a longer path shows the first, "…", and the last two. */
const MAX_CRUMBS = 4;

const CRUMB =
  'h-6 max-w-[96px] cursor-pointer truncate rounded-sm border-0 bg-transparent px-1 text-caption font-semibold text-text-muted hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-focus-ring';

export type Crumb = { readonly id: string; readonly text: string };

export function labelText(label: ItemLabel): string {
  return label.kind === 'column'
    ? formatString('label.column', { n: String(label.n) })
    : label.text;
}

/** The path to an item as the bar shows it. */
export type CrumbLayout = {
  readonly path: readonly Crumb[];
  /** What is on show: the whole path, or the first level, "more" and the last two. */
  readonly shown: readonly (Crumb | 'more')[];
  /** The levels behind "more". */
  readonly hidden: readonly Crumb[];
  /** The selected item's own label, the last crumb. */
  readonly itemLabel: string;
};

export function crumbLayout(
  model: TreeModel,
  session: Pick<EditorSession, 'catalogue'>,
  selectedId: string,
): CrumbLayout {
  const byKey = catalogueByKey(session.catalogue);
  const path: Crumb[] = breadcrumb(model, selectedId).map((node) => ({
    id: node.id,
    text: labelText(labelOf(model, byKey, node.id)),
  }));
  const collapsed = path.length > MAX_CRUMBS;
  const hidden = collapsed ? path.slice(1, path.length - 2) : [];
  const shown: readonly (Crumb | 'more')[] = collapsed
    ? [path[0], 'more', ...path.slice(-2)].filter(
        (entry): entry is Crumb | 'more' => entry !== undefined,
      )
    : path;
  return { path, shown, hidden, itemLabel: path[path.length - 1]?.text ?? '' };
}

/** The roving-tabindex keys a layout's crumbs take, in order. */
export function crumbKeys(
  layout: CrumbLayout,
  selectedId: string,
): readonly string[] {
  return layout.shown.flatMap((entry) =>
    entry === 'more'
      ? ['more']
      : entry.id === selectedId
        ? []
        : [`crumb:${entry.id}`],
  );
}

/** What a roving control spreads onto its element. */
export type Rove = (key: string) => {
  readonly 'data-roving': string;
  readonly tabIndex: number;
  readonly onFocus: () => void;
};

/**
 * One tab stop over a row of controls, with the arrow keys, Home and End moving
 * between them. `keys` is every control of the row in order; the one last
 * focused (or the first) is the stop.
 */
export function useRoving(keys: readonly string[]): {
  readonly rove: Rove;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  const [active, setActive] = useState('');
  const current = keys.includes(active) ? active : (keys[0] ?? '');
  const rove: Rove = (key) => ({
    'data-roving': key,
    tabIndex: current === key ? 0 : -1,
    onFocus: () => {
      setActive(key);
    },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
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
  return { rove, onKeyDown };
}

export type CrumbsProps = {
  readonly store: EditorStore;
  readonly model: TreeModel;
  readonly selectedId: string;
  readonly layout: CrumbLayout;
  readonly rove: Rove;
};

/**
 * The path to the selected item as crumb buttons (a longer path shows its
 * first level, "…" and the last two, the rest in a list below the bar). Shared
 * by the block toolbar and the compact field bar, so both read and behave the
 * same.
 */
export function Crumbs(props: CrumbsProps): ReactElement {
  const { store, model, selectedId, layout, rove } = props;
  const { shown, hidden } = layout;
  /** The item whose hidden path levels are listed, and where the list hangs below the bar. */
  const [menu, setMenu] = useState<{
    readonly itemId: string;
    readonly left: number;
  } | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list belongs to the item it was opened for: a new selection closes it.
  const open = menu !== null && menu.itemId === selectedId ? menu : null;

  const selectCrumbById = (id: string): void => {
    setMenu(null);
    selectAndAnnounce(store, selectCrumb(model, id));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && open !== null) {
      event.stopPropagation();
      setMenu(null);
      moreButton.current?.focus();
    }
  };

  // Focus leaving the crumbs closes the list of hidden levels.
  const onBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (
      open !== null &&
      !(
        isNodeLike(next) &&
        (nav.current?.contains(next) === true ||
          list.current?.contains(next) === true)
      )
    ) {
      setMenu(null);
    }
  };

  return (
    <>
      <nav
        ref={nav}
        className="flex min-w-0 items-center gap-1 overflow-hidden px-1"
        aria-label={STRINGS['toolbar.breadcrumb']}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
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
              <span key="more" className="flex items-center gap-1">
                {separator}
                <button
                  ref={moreButton}
                  type="button"
                  className={CRUMB}
                  aria-label={STRINGS['toolbar.more.label']}
                  aria-expanded={open !== null}
                  onClick={(event) => {
                    // The list hangs below the bar, under this button.
                    setMenu(
                      open !== null
                        ? null
                        : {
                            itemId: selectedId,
                            left: event.currentTarget.offsetLeft,
                          },
                    );
                  }}
                  {...rove('more')}
                >
                  {STRINGS['toolbar.more']}
                </button>
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
      {open !== null && hidden.length > 0 ? (
        // Outside the crumbs, which clip what overflows them: the bar does not.
        <div
          ref={list}
          role="group"
          data-toolbar-hidden-levels=""
          className="pk-toolbar-menu"
          aria-label={STRINGS['toolbar.more.label']}
          style={{ left: open.left }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        >
          {hidden.map((crumb) => (
            <button
              key={crumb.id}
              type="button"
              className={CRUMB}
              title={crumb.text}
              onClick={() => {
                selectCrumbById(crumb.id);
              }}
            >
              {crumb.text}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
