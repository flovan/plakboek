import type { ReactElement, ReactNode } from 'react';
import type { SubField } from '../../../client/session/control-map.js';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  TrashIcon,
} from '../../icons.js';
import { STRINGS } from '../../strings.js';

type Row = Readonly<Record<string, unknown>>;

const ICON_BUTTON =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent';

const ADD_BUTTON =
  'flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-disabled:cursor-default aria-disabled:opacity-60';

function rowsOf(value: unknown): readonly Row[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((row) =>
    typeof row === 'object' && row !== null && !Array.isArray(row)
      ? (row as Row)
      : {},
  );
}

export type RepeaterControlProps = {
  readonly labelId: string;
  readonly describedBy: string | undefined;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly attention: boolean;
  readonly subFields: readonly SubField[];
  /** The whole list changes: rows added, moved, removed or edited. */
  readonly onChange: (value: unknown, immediate: boolean) => void;
  readonly onBlur: () => void;
  /** Draws one sub-field of one row; the row calls `change` with that field's value. */
  readonly renderSubField: (
    field: SubField,
    row: number,
    value: unknown,
    change: (value: unknown, immediate: boolean) => void,
  ) => ReactNode;
};

/**
 * A list of bordered groups, one per row, each with its sub-fields and 32px
 * buttons to move it earlier or later or remove it, and an "Add item" button
 * below. The list may be empty. Moving, adding and removing apply at once;
 * typing in a sub-field follows that field's own timing.
 */
export function RepeaterControl(props: RepeaterControlProps): ReactElement {
  const rows = rowsOf(props.value);
  const { disabled, onChange, onBlur } = props;

  const replace = (next: readonly Row[], immediate: boolean): void => {
    onChange(next, immediate);
  };
  const move = (from: number, to: number): void => {
    const next = [...rows];
    const [taken] = next.splice(from, 1);
    if (taken === undefined) return;
    next.splice(to, 0, taken);
    replace(next, true);
  };

  return (
    <div
      role="group"
      aria-labelledby={props.labelId}
      aria-describedby={props.describedBy}
      aria-invalid={props.invalid ? true : undefined}
      data-repeater=""
      className={`flex flex-col gap-2 ${
        props.attention ? 'rounded-lg border border-attention p-2' : ''
      }`}
      onBlur={onBlur}
    >
      {rows.map((row, at) => (
        <div
          // Rows have no identity of their own; the position is it.
          key={at}
          data-repeater-row={at}
          className="box-border flex flex-col gap-4 rounded-lg border border-border p-4"
        >
          {props.subFields.map((field) =>
            props.renderSubField(
              field,
              at,
              row[field.key],
              (value, immediate) => {
                // A cleared sub-field is a key the row no longer has.
                const nextRow = Object.fromEntries(
                  Object.entries({ ...row, [field.key]: value }).filter(
                    ([, entry]) => entry !== undefined,
                  ),
                );
                replace(
                  rows.map((existing, index) =>
                    index === at ? nextRow : existing,
                  ),
                  immediate,
                );
              },
            ),
          )}
          <div className="flex gap-1">
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={STRINGS['panel.repeater.moveEarlier']}
              aria-disabled={disabled || at === 0}
              data-repeater-action="earlier"
              onClick={() => {
                if (!disabled && at > 0) move(at, at - 1);
              }}
            >
              <ArrowUpIcon />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={STRINGS['panel.repeater.moveLater']}
              aria-disabled={disabled || at === rows.length - 1}
              data-repeater-action="later"
              onClick={() => {
                if (!disabled && at < rows.length - 1) move(at, at + 1);
              }}
            >
              <ArrowDownIcon />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={STRINGS['panel.repeater.remove']}
              aria-disabled={disabled}
              data-repeater-action="remove"
              onClick={() => {
                if (disabled) return;
                replace(
                  rows.filter((_, index) => index !== at),
                  true,
                );
              }}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className={ADD_BUTTON}
        aria-disabled={disabled}
        data-repeater-action="add"
        onClick={() => {
          if (!disabled) replace([...rows, {}], true);
        }}
      >
        <PlusIcon />
        {STRINGS['panel.repeater.add']}
      </button>
    </div>
  );
}
