import type { MouseEvent, ReactElement, ReactNode } from 'react';
import {
  CUSTOM_SIZE_MAX,
  CUSTOM_SIZE_MIN,
  parseCustomSize,
} from '@plakboek/content/rich-text';
import { CheckIcon, ChevronDownIcon } from '../../icons.js';
import { formatString, STRINGS } from '../../strings.js';
import type { Rove } from './crumbs.js';
import {
  CustomValueInput,
  POPOVER_ROW,
  StylePopover,
  type PopoverApi,
} from './style-popover.js';
import type { CustomStyleControl } from './toolbar-state.js';

export type SizePopoverProps = {
  readonly entries: CustomStyleControl['sizes'];
  readonly allowCustomValues: boolean;
  /** The stored size at the selection: a token, a px literal or null. */
  readonly current: string | null;
  /** What the button shows: the entry's label, "{n}px" or "Theme default". */
  readonly currentLabel: string;
  /** A palette token, a typed px literal, or null for "Theme default". */
  readonly onChoose: (
    choice: { token: string } | { value: string } | null,
    label: string,
  ) => void;
  readonly onReturn: () => void;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
};

function Row(props: {
  readonly selected: boolean;
  readonly name: string;
  readonly onClick: (event: MouseEvent) => void;
  readonly children: ReactNode;
}): ReactElement {
  const { selected, name, onClick, children } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={-1}
      className={POPOVER_ROW}
      data-pop-item=""
      data-size-row={name}
      data-current={selected ? '' : undefined}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onClick}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {selected ? <CheckIcon /> : null}
      </span>
      {children}
    </button>
  );
}

function List(props: SizePopoverProps & { readonly api: PopoverApi }) {
  const { entries, allowCustomValues, current, onChoose, api } = props;
  return (
    <>
      <div
        role="radiogroup"
        aria-label={STRINGS['text.size.label']}
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto"
        data-size-list=""
      >
        <Row
          name="default"
          selected={current === null}
          onClick={api.choose(() => {
            onChoose(null, STRINGS['text.themeDefault']);
          })}
        >
          {STRINGS['text.themeDefault']}
        </Row>
        {entries.map((entry) => (
          <Row
            key={entry.token}
            name={entry.token}
            selected={current === entry.token}
            onClick={api.choose(() => {
              onChoose({ token: entry.token }, entry.label);
            })}
          >
            <span className="min-w-0 flex-1 truncate" title={entry.label}>
              {entry.label}
            </span>
            {entry.value === undefined ? null : (
              <span className="shrink-0 text-caption text-text-muted">
                {entry.value}
              </span>
            )}
          </Row>
        ))}
      </div>
      {allowCustomValues ? (
        <CustomValueInput
          name="size"
          label={STRINGS['text.size.custom']}
          hint={formatString('text.size.hint', {
            min: String(CUSTOM_SIZE_MIN),
            max: String(CUSTOM_SIZE_MAX),
          })}
          error={formatString('text.size.error', {
            min: String(CUSTOM_SIZE_MIN),
            max: String(CUSTOM_SIZE_MAX),
          })}
          inputMode="numeric"
          after={STRINGS['text.size.unit']}
          parse={parseCustomSize}
          onApply={(value) => {
            onChoose({ value }, value);
          }}
          onDone={api.closeToField}
        />
      ) : null}
    </>
  );
}

/**
 * The Size button and its popover: "Theme default", then each theme size with
 * its value when the host gives one, and, when the theme allows custom values,
 * a px input pinned under the list. A palette entry is stored as a token, so it
 * follows theme changes; a typed size is stored as written.
 */
export function SizePopover(props: SizePopoverProps): ReactElement {
  const { currentLabel, onReturn, rove, tooltipSide } = props;
  return (
    <StylePopover
      id="size"
      label={`${STRINGS['text.size.label']}: ${currentLabel}`}
      tooltip={STRINGS['text.size.label']}
      rove={rove}
      tooltipSide={tooltipSide}
      onReturn={onReturn}
      button={
        <>
          <span className="min-w-0 truncate" title={currentLabel}>
            {currentLabel}
          </span>
          <ChevronDownIcon />
        </>
      }
    >
      {(api) => <List {...props} api={api} />}
    </StylePopover>
  );
}
