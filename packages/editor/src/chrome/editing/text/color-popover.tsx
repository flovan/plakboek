import type { CSSProperties, MouseEvent, ReactElement } from 'react';
import { parseCustomColor } from '@plakboek/content/rich-text';
import { CheckIcon, ChevronDownIcon } from '../../icons.js';
import { STRINGS } from '../../strings.js';
import { Tooltip } from '../../tooltip.js';
import type { Rove } from './crumbs.js';
import {
  CustomValueInput,
  StylePopover,
  type PopoverApi,
} from './style-popover.js';
import type { CustomStyleControl } from './toolbar-state.js';

export type ColorPopoverProps = {
  readonly entries: CustomStyleControl['colors'];
  readonly allowCustomValues: boolean;
  /** The stored colour at the selection: a token, a hex literal or null. */
  readonly current: string | null;
  /** The label of the current colour, when there is one. */
  readonly currentLabel: string | null;
  /** A palette token, a typed hex literal, or null for "Theme default". */
  readonly onChoose: (
    choice: { token: string } | { value: string } | null,
    label: string,
  ) => void;
  readonly onReturn: () => void;
  readonly rove: Rove;
  readonly tooltipSide: 'top' | 'bottom';
};

/** The fill of a stored colour, in the site's own terms. */
export function swatchFill(current: string | null): string | undefined {
  if (current === null) return undefined;
  return /^[a-z]/.test(current) ? `var(--color-${current})` : current;
}

/** White disc crossed by a diagonal line: "Theme default". */
const DEFAULT_SWATCH: CSSProperties = {
  background:
    'linear-gradient(to top right, transparent calc(50% - 1px), var(--pk-text) calc(50% - 1px), var(--pk-text) calc(50% + 1px), transparent calc(50% + 1px)), var(--pk-surface)',
};

const SWATCH =
  'relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border p-0 focus-visible:outline-2 focus-visible:outline-focus-ring';

/** The selected swatch: a 2px ring with a 2px gap. */
const SELECTED =
  'shadow-[0_0_0_2px_var(--color-surface),0_0_0_4px_var(--color-text)]';

function Swatch(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly style: CSSProperties;
  readonly name: string;
  readonly onClick: (event: MouseEvent) => void;
}): ReactElement {
  const { label, selected, style, name, onClick } = props;
  return (
    <Tooltip label={label} placement="bottom">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        tabIndex={-1}
        className={`${SWATCH} ${selected ? SELECTED : ''}`}
        style={style}
        data-pop-item=""
        data-swatch={name}
        data-current={selected ? '' : undefined}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={onClick}
      >
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface text-text [&>svg]:h-3 [&>svg]:w-3"
          >
            <CheckIcon />
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}

function Grid(props: ColorPopoverProps & { readonly api: PopoverApi }) {
  const { entries, allowCustomValues, current, onChoose, api } = props;
  const isToken = (token: string): boolean => current === token;
  const isLiteral =
    current !== null && !entries.some((e) => e.token === current);
  return (
    <>
      <div
        role="radiogroup"
        aria-label={STRINGS['text.color.label']}
        className="flex min-h-0 flex-1 flex-wrap content-start gap-2 overflow-y-auto p-2"
        data-swatch-grid=""
      >
        <Swatch
          label={STRINGS['text.themeDefault']}
          selected={current === null}
          style={DEFAULT_SWATCH}
          name="default"
          onClick={api.choose(() => {
            onChoose(null, STRINGS['text.themeDefault']);
          })}
        />
        {entries.map((entry) => (
          <Swatch
            key={entry.token}
            label={entry.label}
            selected={isToken(entry.token)}
            style={{ backgroundColor: `var(--color-${entry.token})` }}
            name={entry.token}
            onClick={api.choose(() => {
              onChoose({ token: entry.token }, entry.label);
            })}
          />
        ))}
      </div>
      {allowCustomValues ? (
        <CustomValueInput
          name="color"
          label={STRINGS['text.color.custom']}
          hint={STRINGS['text.color.hint']}
          error={STRINGS['text.color.error']}
          inputMode="text"
          parse={parseCustomColor}
          onApply={(value) => {
            onChoose({ value }, value);
          }}
          onDone={api.closeToField}
          before={
            <span
              aria-hidden="true"
              className="h-6 w-6 shrink-0 rounded-md border border-border"
              style={isLiteral ? { backgroundColor: current } : DEFAULT_SWATCH}
            />
          }
        />
      ) : null}
    </>
  );
}

/**
 * The Color button and its popover: a "Theme default" swatch, then one swatch
 * per theme colour, filled with the site's own colour variable; and, when the
 * theme allows custom values, a hex input pinned under the grid. Choosing a
 * swatch stores the token, so the colour follows theme changes; a typed hex is
 * stored as written.
 */
export function ColorPopover(props: ColorPopoverProps): ReactElement {
  const { current, currentLabel, onReturn, rove, tooltipSide } = props;
  const name =
    currentLabel === null
      ? STRINGS['text.color.label']
      : `${STRINGS['text.color.label']}: ${currentLabel}`;
  return (
    <StylePopover
      id="color"
      label={name}
      tooltip={STRINGS['text.color.label']}
      rove={rove}
      tooltipSide={tooltipSide}
      onReturn={onReturn}
      button={
        <>
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-4 w-4 shrink-0 rounded-full border border-border"
              style={
                current === null
                  ? DEFAULT_SWATCH
                  : { backgroundColor: swatchFill(current) }
              }
              data-color-current=""
            />
            {STRINGS['text.color']}
          </span>
          <ChevronDownIcon />
        </>
      }
    >
      {(api) => <Grid {...props} api={api} />}
    </StylePopover>
  );
}
