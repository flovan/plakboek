import { useId, useState, type ReactElement } from 'react';
import type { CatalogueEntry, EditPosition } from '../../api-types.js';
import {
  insertionTarget,
  paletteGroups,
} from '../../client/session/insertion.js';
import type { Point } from '../../client/overlay/geometry.js';
import { legalityContextOf } from '../../client/session/move-action.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { formatString, STRINGS } from '../strings.js';

const ROW =
  'flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:text-text-muted aria-disabled:hover:bg-transparent';

export type PaletteProps = {
  readonly store: EditorStore;
  /** The editor chose a type and a place for it. */
  readonly onInsert: (entry: CatalogueEntry, position: EditPosition) => void;
  /** A row was pressed: it becomes a drag once the pointer has moved 4px. */
  readonly onDragStart?: (entry: CatalogueEntry, origin: Point) => void;
};

/**
 * The Blocks palette in the sidebar's panel region: every block type by
 * category with a search field that stays at the top while the region
 * scrolls. A row adds its type right after the selection, at the nearest level
 * where the type is legal; with nothing selected only a section type has a
 * place, at the end of the page. A row with no place says why and does
 * nothing.
 */
export function Palette(props: PaletteProps): ReactElement | null {
  const { store, onInsert, onDragStart } = props;
  const state = useEditorStore(store, (current) => current);
  const [query, setQuery] = useState('');
  const base = useId();
  const ctx = legalityContextOf(state);
  if (state.status !== 'editing' || state.mode !== 'edit' || ctx === null) {
    return null;
  }
  const groups = paletteGroups(ctx, query);
  const nothingSelected = state.selection.selectedId === null;

  return (
    <section aria-label={STRINGS['panel.tab.blocks']} data-palette="">
      <div className="sticky top-0 z-1 bg-surface pb-2">
        <label htmlFor={`${base}-search`} className="sr-only">
          {STRINGS['picker.search']}
        </label>
        <input
          id={`${base}-search`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="box-border h-10 w-full rounded-lg border border-control-border bg-input-fill px-3 text-body text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        />
      </div>
      {groups.length === 0 ? (
        <p className="m-0 py-2 text-body text-text-muted wrap-anywhere">
          {formatString('picker.noMatch', { query: query.trim() })}
        </p>
      ) : (
        groups.map((group, at) => (
          <div
            key={group.category}
            role="group"
            aria-labelledby={`${base}-group-${at}`}
            className="mb-2"
          >
            <div
              id={`${base}-group-${at}`}
              className="px-3 pt-2 pb-1 text-caption font-semibold text-text-muted"
            >
              {group.category}
            </div>
            {group.entries.map((entry) => {
              const target = insertionTarget(ctx, state.selection, entry.key);
              const reason =
                target !== null
                  ? null
                  : nothingSelected && entry.kind !== 'section'
                    ? STRINGS['panel.palette.selectFirst']
                    : STRINGS['panel.palette.notHere'];
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={ROW}
                  data-palette-row={entry.key}
                  aria-disabled={target === null}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || !event.isPrimary) return;
                    onDragStart?.(entry, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onClick={() => {
                    if (target !== null) onInsert(entry, target);
                  }}
                >
                  <span className="text-body font-semibold">
                    {entry.editor.label}
                  </span>
                  {entry.editor.description === undefined ? null : (
                    <span className="text-body text-text-muted wrap-anywhere">
                      {entry.editor.description}
                    </span>
                  )}
                  {reason === null ? null : (
                    <span className="text-caption font-semibold text-text-muted">
                      {reason}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}
