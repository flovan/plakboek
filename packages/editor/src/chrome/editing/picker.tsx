import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { CatalogueEntry } from '../../api-types.js';
import {
  pickerPlacement,
  type PickerPlacement,
} from '../../client/overlay/slot-geometry.js';
import type { Box } from '../../client/overlay/geometry.js';
import {
  pickerGroups,
  type InsertSlot,
  type PickerGroup,
} from '../../client/session/insertion.js';
import { legalityContextOf } from '../../client/session/move-action.js';
import { legalTypesAt } from '../../client/session/legality.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../client/session/store.js';
import { formatString, STRINGS } from '../strings.js';

const OPTION =
  'flex min-h-10 cursor-pointer flex-col justify-center gap-0.5 px-3 py-2 text-left aria-selected:bg-surface-muted';

export type PickerProps = {
  readonly store: EditorStore;
  /** The gap the chosen type is added to. */
  readonly slot: InsertSlot;
  /** What the picker hangs from, in the shell's coordinates. */
  readonly anchor: Box;
  /** The frame's content box in the shell's coordinates. */
  readonly frame: Box;
  /** The editor chose a type. */
  readonly onPick: (entry: CatalogueEntry) => void;
  /** Escape: closes and hands focus back to what opened the picker. */
  readonly onClose: () => void;
  /** Focus or a press went elsewhere: closes and leaves focus where it went. */
  readonly onDismiss: () => void;
};

function Rows(props: {
  readonly groups: readonly PickerGroup[];
  readonly idOf: (key: string) => string;
  readonly activeKey: string | null;
  readonly labelId: string;
  readonly onActive: (key: string) => void;
  readonly onPick: (entry: CatalogueEntry) => void;
}): ReactElement {
  const { groups, idOf, activeKey, labelId, onActive, onPick } = props;
  return (
    <>
      {groups.map((group, at) => (
        <div
          key={group.category}
          role="group"
          aria-labelledby={`${labelId}-${at}`}
        >
          <div
            id={`${labelId}-${at}`}
            className="px-3 pt-2 pb-1 text-caption font-semibold text-text-muted"
          >
            {group.category}
          </div>
          {group.entries.map((entry) => (
            <div
              key={entry.key}
              id={idOf(entry.key)}
              role="option"
              aria-selected={entry.key === activeKey}
              data-option={entry.key}
              className={OPTION}
              onMouseDown={(event) => {
                // Keep focus in the search input.
                event.preventDefault();
              }}
              onMouseMove={() => {
                onActive(entry.key);
              }}
              onClick={() => {
                onPick(entry);
              }}
            >
              <span className="text-body font-semibold text-text">
                {entry.editor.label}
              </span>
              {entry.editor.description === undefined ? null : (
                <span className="text-body text-text-muted wrap-anywhere">
                  {entry.editor.description}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * The picker: a non-modal popover with a search field and the types legal in
 * one gap, grouped by category. The arrow keys move the active option, Enter
 * adds it and Escape closes. Focus stays in the search field, which names the
 * active option for assistive technology, so the keyboard needs no more than
 * the field. It is drawn in the interaction plane, so it never leaves the
 * frame.
 */
export function Picker(props: PickerProps): ReactElement | null {
  const { store, slot, anchor, frame, onPick, onClose, onDismiss } = props;
  const state = useEditorStore(store, (current) => current);
  const ctx = legalityContextOf(state);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const base = useId();
  const listId = `${base}-list`;
  const idOf = (key: string): string => `${base}-${key}`;

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  // A press outside the picker closes it. A press in the framed site never
  // reaches the shell, so the shell closes the picker for its own clicks.
  useEffect(() => {
    const rootNode = root.current?.getRootNode();
    if (!(rootNode instanceof ShadowRoot || rootNode instanceof Document)) {
      return undefined;
    }
    const onPointerDown = (event: Event): void => {
      if (event.composedPath().includes(root.current as EventTarget)) return;
      onDismiss();
    };
    rootNode.addEventListener('pointerdown', onPointerDown);
    return () => {
      rootNode.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onDismiss]);

  const groups = ctx === null ? [] : pickerGroups(ctx, slot, query);
  const flat = groups.flatMap((group) => group.entries);
  const activeKey = flat.some((entry) => entry.key === active)
    ? active
    : (flat[0]?.key ?? null);

  useEffect(() => {
    if (activeKey === null) return;
    root.current
      ?.querySelector(`[data-option="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  if (ctx === null) return null;
  const anyLegal = legalTypesAt(ctx, slot.parentId).some(
    (key) => ctx.catalogue.get(key)?.kind !== 'column',
  );
  const placement: PickerPlacement = pickerPlacement(anchor, frame);
  const step = (by: 1 | -1): void => {
    if (flat.length === 0) return;
    const at = flat.findIndex((entry) => entry.key === activeKey);
    const next = flat[(at + by + flat.length) % flat.length];
    if (next !== undefined) setActive(next.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = flat.find((entry) => entry.key === activeKey);
      if (chosen !== undefined) onPick(chosen);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={
        slot.level === 'section'
          ? STRINGS['picker.section']
          : STRINGS['picker.block']
      }
      className="pk-picker"
      data-picker=""
      data-side={placement.side}
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        transform: placement.side === 'above' ? 'translateY(-100%)' : undefined,
      }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next as Node)) {
          onDismiss();
        }
      }}
    >
      <label htmlFor={`${base}-search`} className="sr-only">
        {STRINGS['picker.search']}
      </label>
      <input
        ref={input}
        id={`${base}-search`}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeKey === null ? undefined : idOf(activeKey)}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(null);
        }}
        className="h-10 shrink-0 rounded-none border-0 border-b border-border bg-input-fill px-3 text-body text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={STRINGS['picker.search']}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Rows
          groups={groups}
          idOf={idOf}
          activeKey={activeKey}
          labelId={`${base}-group`}
          onActive={setActive}
          onPick={onPick}
        />
      </div>
      {flat.length > 0 ? null : anyLegal ? (
        <p className="m-0 px-3 py-4 text-body text-text-muted wrap-anywhere">
          {formatString('picker.noMatch', { query: query.trim() })}
        </p>
      ) : (
        <div className="px-3 py-4">
          <p className="m-0 text-body font-semibold text-text">
            {STRINGS['picker.nothing.heading']}
          </p>
          <p className="mt-1 mb-0 text-body text-text-muted">
            {STRINGS['picker.nothing.body']}
          </p>
        </div>
      )}
    </div>
  );
}
