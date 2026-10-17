import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { revealInFrame } from '../../client/frame/reveal.js';
import {
  keyMove,
  treeRows,
  type TreeKey,
} from '../../client/session/page-tree.js';
import { selectCrumb } from '../../client/session/scope.js';
import { selectAndAnnounce } from '../../client/session/selection-announcement.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { ChevronRightIcon } from '../icons.js';
import { STRINGS } from '../strings.js';

const ROW =
  'group flex h-8 cursor-pointer items-center rounded-lg pr-2 text-body text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring aria-selected:bg-text aria-selected:text-surface aria-selected:hover:bg-text';

const TREE_KEYS: ReadonlySet<string> = new Set<TreeKey>([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
]);

function isTreeKey(key: string): key is TreeKey {
  return TREE_KEYS.has(key);
}

/** The framed site, found through the shadow root the tree sits in. */
function frameOf(tree: HTMLElement | null): HTMLIFrameElement | null {
  const root = tree?.getRootNode();
  const frame =
    root instanceof ShadowRoot || root instanceof Document
      ? root.querySelector('iframe')
      : null;
  return frame instanceof HTMLIFrameElement ? frame : null;
}

export type PageTreeProps = {
  readonly store: EditorStore;
};

/**
 * "Page structure": everything on the page in page order, from the sections
 * down to the items inside blocks, in the sidebar's panel region. A row selects
 * its item and brings it into view on the page; a double-click or Enter also
 * opens its Properties. Hovering or focusing a row outlines its block on the
 * page. It is a keyboard-complete tree with one tab stop. It is shown only
 * while the page is being edited in Edit mode, because nothing can be selected
 * in Interact mode.
 */
export function PageTree(props: PageTreeProps): ReactElement | null {
  const { store } = props;
  const shown = useEditorStore(
    store,
    (state) => state.status === 'editing' && state.mode === 'edit',
  );
  const model = useEditorStore(store, (state) => state.model);
  const session = useEditorStore(store, (state) => state.session);
  const selectedId = useEditorStore(
    store,
    (state) => state.selection.selectedId,
  );
  const tree = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Collapsing lasts for the session only; every row starts expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The row focus is on, while it is inside the tree: the one tab stop.
  const [focused, setFocused] = useState<string | null>(null);
  // The selection the panel has yet to scroll its row into view for.
  const pendingScroll = useRef<string | null>(null);

  const catalogueByKey = useMemo(
    () =>
      new Map((session?.catalogue ?? []).map((entry) => [entry.key, entry])),
    [session],
  );
  const rows = useMemo(
    () => (model === null ? [] : treeRows(model, catalogueByKey, collapsed)),
    [model, catalogueByKey, collapsed],
  );

  // Whatever the tree points at on the page is let go when the tree goes.
  useEffect(
    () => () => {
      store.setHighlight(null);
    },
    [store],
  );

  // A selection made anywhere opens the way to its row and shows it.
  useEffect(() => {
    pendingScroll.current = selectedId;
    if (selectedId === null || model === null) return;
    const closed = model
      .ancestorsOf(selectedId)
      .filter((ancestor) => collapsed.has(ancestor.id));
    if (closed.length === 0) return;
    setCollapsed((current) => {
      const next = new Set(current);
      for (const ancestor of closed) next.delete(ancestor.id);
      return next;
    });
    // Only a new selection opens the way; collapsing afterwards is the editor's.
  }, [selectedId]);

  useEffect(() => {
    const id = pendingScroll.current;
    if (id === null) return;
    const element = rowElement(tree.current, id);
    if (element === null) return;
    pendingScroll.current = null;
    element.scrollIntoView({ block: 'nearest' });
  });

  if (!shown || model === null) return null;

  const tabStop = rows.some((row) => row.id === focused)
    ? focused
    : rows.some((row) => row.id === selectedId)
      ? selectedId
      : (rows[0]?.id ?? null);

  // Selecting is the click's own work; the scroll waits a frame so the
  // lifecycle hooks a selection runs have shown the item first.
  const choose = (id: string): void => {
    const current = store.getState().model;
    if (current === null) return;
    selectAndAnnounce(store, selectCrumb(current, id));
    const frame = frameOf(root.current);
    requestAnimationFrame(() => {
      if (frame !== null) revealInFrame(frame, id);
    });
  };

  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const onKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    id: string,
  ): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      choose(id);
      if (event.key === 'Enter') store.requestProperties(id);
      return;
    }
    if (!isTreeKey(event.key)) return;
    const move = keyMove(rows, id, event.key);
    event.preventDefault();
    if (move === null) return;
    if (move.action === 'focus') {
      rowElement(tree.current, move.id)?.focus();
    } else {
      toggle(id);
    }
  };

  return (
    <div ref={root} data-page-structure="" className="mb-4">
      <h2 className="m-0 mb-2 text-body font-semibold text-text">
        {STRINGS['tree.heading']}
      </h2>
      {rows.length === 0 ? (
        <p className="m-0 text-body text-text-muted wrap-anywhere">
          {STRINGS['tree.empty']}
        </p>
      ) : (
        <div
          ref={tree}
          role="tree"
          aria-label={STRINGS['tree.heading']}
          data-page-tree=""
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node && tree.current?.contains(next))) {
              store.setHighlight(null);
              setFocused(null);
            }
          }}
        >
          {rows.map((row) => (
            <div
              key={row.id}
              role="treeitem"
              data-tree-row={row.id}
              aria-level={row.level}
              aria-setsize={row.setSize}
              aria-posinset={row.posInSet}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={row.id === selectedId}
              tabIndex={row.id === tabStop ? 0 : -1}
              className={ROW}
              style={{ paddingLeft: (row.level - 1) * 16 }}
              onClick={() => {
                choose(row.id);
              }}
              onDoubleClick={() => {
                store.requestProperties(row.id);
              }}
              onKeyDown={(event) => {
                onKeyDown(event, row.id);
              }}
              onPointerEnter={() => {
                store.setHighlight(row.id);
              }}
              onPointerLeave={() => {
                // The row that still has keyboard focus keeps its outline.
                if (store.getState().highlight === row.id) {
                  store.setHighlight(focused);
                }
              }}
              onFocus={() => {
                setFocused(row.id);
                store.setHighlight(row.id);
              }}
            >
              <span
                aria-hidden="true"
                data-tree-toggle={row.hasChildren ? '' : undefined}
                className="flex h-8 w-6 shrink-0 items-center justify-center"
                onClick={
                  row.hasChildren
                    ? (event) => {
                        event.stopPropagation();
                        toggle(row.id);
                      }
                    : undefined
                }
                onDoubleClick={
                  row.hasChildren
                    ? (event) => {
                        event.stopPropagation();
                      }
                    : undefined
                }
              >
                {row.hasChildren ? (
                  <ChevronRightIcon
                    className={
                      row.expanded
                        ? 'rotate-90 motion-safe:transition-transform motion-safe:duration-100'
                        : 'motion-safe:transition-transform motion-safe:duration-100'
                    }
                  />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.needsInput ? (
                <span className="shrink-0 pl-2 text-caption text-attention group-aria-selected:text-surface">
                  {STRINGS['panel.needsInput']}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The row of an item in the tree, if it is shown. */
function rowElement(tree: HTMLElement | null, id: string): HTMLElement | null {
  const view = tree?.ownerDocument.defaultView;
  if (tree === null || view === null || view === undefined) return null;
  return tree.querySelector<HTMLElement>(
    `[data-tree-row="${view.CSS.escape(id)}"]`,
  );
}
