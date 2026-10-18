import type { ReactElement } from 'react';
import type { ModelNode } from '../../../api-types.js';
import { legalityContextOf } from '../../../client/session/move-action.js';
import {
  moveTargetReason,
  type MoveDirection,
} from '../../../client/session/move-targets.js';
import { selectCrumb } from '../../../client/session/scope.js';
import { selectAndAnnounce } from '../../../client/session/selection-announcement.js';
import {
  deleteBlockedReason,
  deleteImpact,
} from '../../../client/session/structure-actions.js';
import {
  useEditorStore,
  type EditorStore,
} from '../../../client/session/store.js';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ColumnsIcon,
  TrashIcon,
} from '../../icons.js';
import { formatString, STRINGS } from '../../strings.js';

const ICON_BUTTON =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent';

const SECONDARY_BUTTON =
  'flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const MOVE_ICON = {
  vertical: { earlier: ArrowUpIcon, later: ArrowDownIcon },
  horizontal: { earlier: ArrowLeftIcon, later: ArrowRightIcon },
} as const;

export type ColumnsGroupProps = {
  readonly store: EditorStore;
  readonly section: ModelNode;
  /** Whether the section's columns sit side by side or stacked in the site. */
  readonly columnAxis?: (
    columnIds: readonly string[],
  ) => 'horizontal' | 'vertical';
  readonly onAddColumn?: (sectionId: string) => void;
  readonly onMove?: (id: string, direction: MoveDirection) => void;
  /** A column's Remove: the shell asks first when blocks go with it. */
  readonly onRemove?: (id: string) => void;
};

function countText(count: number): string {
  if (count === 0) return STRINGS['panel.column.empty'];
  return count === 1
    ? STRINGS['panel.column.count.one']
    : formatString('panel.column.count.other', { count: String(count) });
}

/**
 * A section's columns, one row each: its number (a click selects the column
 * in the frame), how many blocks it holds, and move earlier, move later and
 * remove. Under the list, Add column appends one. A button that cannot act
 * stays focusable with its reason as the tooltip.
 */
export function ColumnsGroup(props: ColumnsGroupProps): ReactElement | null {
  const { store, section, columnAxis, onAddColumn, onMove, onRemove } = props;
  const state = useEditorStore(store, (current) => current);
  const { model } = state;
  const ctx = legalityContextOf(state);
  if (model === null || ctx === null) return null;
  const columns = model.childrenOf(section.id);
  const axis = columnAxis?.(columns.map((column) => column.id)) ?? 'horizontal';
  const Icons = MOVE_ICON[axis];

  return (
    <section
      data-properties-group="columns"
      aria-label={STRINGS['panel.group.columns']}
    >
      <h3 className="m-0 mb-2 text-body font-semibold text-text">
        {STRINGS['panel.group.columns']}
      </h3>
      <ul className="m-0 mb-2 flex list-none flex-col p-0">
        {columns.map((column, at) => {
          const name = formatString('label.column', { n: String(at + 1) });
          const moveReason = (direction: MoveDirection): string | null => {
            const reason = moveTargetReason(ctx, column.id, direction);
            if (reason === null) return null;
            return STRINGS[
              reason === 'atStart'
                ? 'toolbar.reason.atStart'
                : 'toolbar.reason.atEnd'
            ];
          };
          const earlier = moveReason('earlier');
          const later = moveReason('later');
          const blocked = deleteBlockedReason(state, column.id);
          const removeReason = blocked === null ? null : STRINGS[blocked];
          return (
            <li
              key={column.id}
              data-column-row={column.id}
              className="flex h-10 items-center gap-1 border-b border-border"
            >
              <button
                type="button"
                data-column-select={column.id}
                className="h-8 min-w-0 cursor-pointer rounded-lg border-0 bg-transparent px-1 text-left text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring"
                onClick={() => {
                  selectAndAnnounce(store, selectCrumb(model, column.id));
                }}
              >
                {name}
              </button>
              <span
                data-column-count=""
                className="min-w-0 flex-1 truncate text-caption text-text-muted"
              >
                {countText(deleteImpact(model, column.id))}
              </span>
              <button
                type="button"
                data-column-move="earlier"
                className={ICON_BUTTON}
                title={earlier ?? undefined}
                aria-label={formatString('panel.column.moveEarlier', {
                  label: name,
                })}
                aria-disabled={earlier !== null}
                onClick={() => {
                  if (earlier === null) onMove?.(column.id, 'earlier');
                }}
              >
                <Icons.earlier />
              </button>
              <button
                type="button"
                data-column-move="later"
                className={ICON_BUTTON}
                title={later ?? undefined}
                aria-label={formatString('panel.column.moveLater', {
                  label: name,
                })}
                aria-disabled={later !== null}
                onClick={() => {
                  if (later === null) onMove?.(column.id, 'later');
                }}
              >
                <Icons.later />
              </button>
              <button
                type="button"
                data-column-remove={column.id}
                className={ICON_BUTTON}
                title={removeReason ?? undefined}
                aria-label={formatString('panel.column.remove', {
                  label: name,
                })}
                aria-disabled={removeReason !== null}
                onClick={() => {
                  if (removeReason === null) onRemove?.(column.id);
                }}
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-add-column=""
        className={SECONDARY_BUTTON}
        onClick={() => {
          onAddColumn?.(section.id);
        }}
      >
        <ColumnsIcon />
        {STRINGS['panel.addColumn']}
      </button>
    </section>
  );
}
