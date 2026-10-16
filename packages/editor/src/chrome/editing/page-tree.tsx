import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { revealInFrame } from '../../client/frame/reveal.js';
import { treeRows } from '../../client/session/page-tree.js';
import { selectCrumb } from '../../client/session/scope.js';
import { selectAndAnnounce } from '../../client/session/selection-announcement.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { STRINGS } from '../strings.js';

const NONE: ReadonlySet<string> = new Set();

const ROW =
  'group flex h-8 cursor-pointer items-center rounded-lg pr-2 text-body text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring aria-selected:bg-text aria-selected:text-surface aria-selected:hover:bg-text';

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
 * its item and brings it into view on the page. It is shown only while the
 * page is being edited in Edit mode, because nothing can be selected in
 * Interact mode.
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

  const catalogueByKey = useMemo(
    () =>
      new Map((session?.catalogue ?? []).map((entry) => [entry.key, entry])),
    [session],
  );
  const rows = useMemo(
    () => (model === null ? [] : treeRows(model, catalogueByKey, NONE)),
    [model, catalogueByKey],
  );

  // Whatever the tree points at on the page is let go when the tree goes.
  useEffect(
    () => () => {
      store.setHighlight(null);
    },
    [store],
  );

  if (!shown || model === null) return null;

  const focusable = rows.some((row) => row.id === selectedId)
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
              tabIndex={row.id === focusable ? 0 : -1}
              className={ROW}
              style={{ paddingLeft: (row.level - 1) * 16 }}
              onClick={() => {
                choose(row.id);
              }}
              onDoubleClick={() => {
                store.requestProperties(row.id);
              }}
              onPointerEnter={() => {
                store.setHighlight(row.id);
              }}
              onPointerLeave={() => {
                if (store.getState().highlight === row.id) {
                  store.setHighlight(null);
                }
              }}
              onFocus={() => {
                store.setHighlight(row.id);
              }}
            >
              <span aria-hidden="true" className="w-6 shrink-0" />
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
