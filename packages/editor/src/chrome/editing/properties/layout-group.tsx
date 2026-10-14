import {
  useCallback,
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  ColumnAlign,
  ModelLayout,
  ModelNode,
} from '../../../api-types.js';
import { normalizeLayout } from '../../../client/session/column-actions.js';
import { hasUnsavedEdit } from '../../../client/session/property-drafts.js';
import {
  equalRatio,
  presetsFor,
  ratioLabelParts,
  ratioTerms,
} from '../../../client/session/presets.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../../client/session/store.js';
import { STRINGS } from '../../strings.js';

/**
 * Asks the shell to render the item with the whole layout and queue its save.
 * Every key is named (undefined clears it). Resolves with whether the engine
 * accepted the layout.
 */
export type LayoutChangeHandler = (
  blockId: string,
  layout: ModelLayout,
  label: string,
) => Promise<boolean>;

type LayoutDraft = {
  readonly value: ModelLayout | null;
  /** `previewing` until the shell has answered; then kept while the save is queued. */
  readonly stage: 'previewing' | 'queued';
};

function sameLayout(left: ModelLayout | null, right: ModelLayout | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The layout an item shows: the editor's last choice while it is being
 * rendered and saved, then the model's. A choice therefore shows at once and
 * never snaps back while its save is still on its way; an undo or any other
 * change of the model's layout ends it.
 */
export function useLayoutDraft(
  store: EditorStore,
  node: ModelNode,
  onLayoutChange: LayoutChangeHandler | undefined,
): {
  readonly layout: ModelLayout | null;
  readonly change: (next: Partial<ModelLayout>, label: string) => void;
} {
  const queue = useEditorStore(store, (state) => state.queue);
  const [draft, setDraft] = useState<LayoutDraft | null>(null);
  const layout = draft === null ? normalizeLayout(node.layout) : draft.value;

  useEffect(() => {
    setDraft((current) => {
      if (current === null || current.stage === 'previewing') return current;
      const saved = sameLayout(normalizeLayout(node.layout), current.value);
      return saved || !hasUnsavedEdit(queue, node.id) ? null : current;
    });
  }, [node, queue]);

  const change = useCallback(
    (next: Partial<ModelLayout>, label: string): void => {
      if (onLayoutChange === undefined) return;
      const value = normalizeLayout({ ...layout, ...next });
      const mine: LayoutDraft = { value, stage: 'previewing' };
      setDraft(mine);
      void onLayoutChange(
        node.id,
        {
          columns: value?.columns,
          align: value?.align,
          fill: value?.fill,
        },
        label,
      ).then((accepted) => {
        setDraft((current) =>
          current !== mine
            ? current
            : accepted
              ? { value, stage: 'queued' }
              : null,
        );
      });
    },
    [layout, node.id, onLayoutChange],
  );

  return { layout, change };
}

type Tile<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly content: ReactNode;
};

const TILE =
  'box-border flex cursor-pointer items-center justify-center rounded-lg border-2 p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const TILE_ON = 'border-text bg-surface-muted';
const TILE_OFF = 'border-border bg-surface hover:bg-surface-muted';

/**
 * A radiogroup of tiles: one tab stop, the arrow keys move the choice (and
 * select it, as radios do), Home and End jump to the ends.
 */
function TileGroup<T extends string>(props: {
  readonly labelId: string;
  readonly name: string;
  readonly tiles: readonly Tile<T>[];
  readonly value: T;
  readonly size: string;
  readonly onChange: (value: T) => void;
}): ReactElement {
  const { labelId, name, tiles, value, size, onChange } = props;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const keys = [
      'ArrowRight',
      'ArrowDown',
      'ArrowLeft',
      'ArrowUp',
      'Home',
      'End',
    ];
    if (!keys.includes(event.key)) return;
    const at = tiles.findIndex((tile) => tile.value === value);
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tiles.length - 1
          : (at + step + tiles.length) % tiles.length;
    const target = tiles[next];
    if (target === undefined) return;
    event.preventDefault();
    onChange(target.value);
    const buttons =
      event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    buttons[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      data-tile-group={name}
      className="flex flex-wrap gap-2"
      onKeyDown={onKeyDown}
    >
      {tiles.map((tile) => {
        const checked = tile.value === value;
        return (
          <button
            key={tile.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={tile.label}
            title={tile.label}
            data-tile={tile.value}
            tabIndex={checked ? 0 : -1}
            className={`${TILE} ${size} ${checked ? TILE_ON : TILE_OFF}`}
            onClick={() => {
              onChange(tile.value);
            }}
          >
            {tile.content}
          </button>
        );
      })}
    </div>
  );
}

/** A preset's columns drawn as bars, as wide as the ratio says. */
function RatioBars(props: { readonly ratio: string }): ReactElement {
  return (
    <span aria-hidden="true" className="flex h-full w-full gap-1 p-2">
      {ratioTerms(props.ratio).map((term, at) => (
        <span
          // The same term can repeat, so the column's place is its key.
          key={`${String(at)}:${term}`}
          className="rounded-sm bg-text-muted"
          style={{ flex: `${term} 1 0`, minWidth: 0 }}
        />
      ))}
    </span>
  );
}

const ALIGN_ORDER: readonly ColumnAlign[] = [
  'stretch',
  'start',
  'center',
  'end',
];

const ALIGN_LABEL = {
  stretch: 'panel.align.stretch',
  start: 'panel.align.start',
  center: 'panel.align.center',
  end: 'panel.align.end',
} as const;

const ALIGN_ITEMS = {
  stretch: 'stretch',
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
} as const;

/** Two columns of different height, lined up the way the choice does. */
function AlignBars(props: { readonly align: ColumnAlign }): ReactElement {
  const { align } = props;
  const tall = align === 'stretch' ? undefined : '16px';
  const short = align === 'stretch' ? undefined : '10px';
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-8 gap-1"
      style={{ alignItems: ALIGN_ITEMS[align] }}
    >
      <span
        className="w-3.5 rounded-sm bg-text-muted"
        style={{ height: short }}
      />
      <span
        className="w-3.5 rounded-sm bg-text-muted"
        style={{ height: tall }}
      />
    </span>
  );
}

export type LayoutGroupProps = {
  readonly store: EditorStore;
  readonly section: ModelNode;
  readonly onLayoutChange?: LayoutChangeHandler;
};

const LABEL = 'text-body font-semibold text-text';

/**
 * A section's layout: how its columns share the width (the presets for the
 * live column count) and how they line up on the cross axis. A choice
 * re-renders the section at once and is saved after a pause.
 */
export function LayoutGroup(props: LayoutGroupProps): ReactElement | null {
  const { store, section, onLayoutChange } = props;
  const session = useEditorStore(store, (state) => state.session);
  const model = useEditorStore(store, (state) => state.model);
  const { layout, change } = useLayoutDraft(store, section, onLayoutChange);
  const widthsId = useId();
  const alignId = useId();
  if (session === null || model === null) return null;

  const count = model.childrenOf(section.id).length;
  const presets = presetsFor(count, session.columnPresets);
  const stored = layout?.columns;
  const ratio =
    stored !== undefined && presets.includes(stored)
      ? stored
      : equalRatio(count);
  const align = layout?.align ?? 'stretch';

  return (
    <section
      data-properties-group="layout"
      aria-label={STRINGS['panel.group.layout']}
    >
      <h3 className="m-0 mb-2 text-body font-semibold text-text">
        {STRINGS['panel.group.layout']}
      </h3>
      <div className="flex flex-col gap-4">
        <div data-layout-field="widths">
          <p id={widthsId} className={`m-0 mb-2 ${LABEL}`}>
            {STRINGS['panel.columnWidths']}
          </p>
          {presets.length <= 1 ? (
            <p className="m-0 text-body text-text-muted">
              {STRINGS['panel.columnsEqual']}
            </p>
          ) : (
            <TileGroup
              labelId={widthsId}
              name="widths"
              value={ratio}
              size="h-10 w-[72px]"
              tiles={presets.map((preset) => ({
                value: preset,
                label: ratioLabelParts(preset).join(
                  STRINGS['panel.preset.separator'],
                ),
                content: <RatioBars ratio={preset} />,
              }))}
              onChange={(value) => {
                change({ columns: value }, STRINGS['panel.columnWidths']);
              }}
            />
          )}
        </div>
        <div data-layout-field="alignment">
          <p id={alignId} className={`m-0 mb-2 ${LABEL}`}>
            {STRINGS['panel.columnAlignment']}
          </p>
          <TileGroup
            labelId={alignId}
            name="alignment"
            value={align}
            size="h-14 w-[60px]"
            tiles={ALIGN_ORDER.map((value) => ({
              value,
              label: STRINGS[ALIGN_LABEL[value]],
              content: (
                <span className="flex flex-col items-center gap-1">
                  <AlignBars align={value} />
                  <span className="text-caption text-text">
                    {STRINGS[ALIGN_LABEL[value]]}
                  </span>
                </span>
              ),
            }))}
            onChange={(value) => {
              change({ align: value }, STRINGS['panel.columnAlignment']);
            }}
          />
        </div>
      </div>
    </section>
  );
}
