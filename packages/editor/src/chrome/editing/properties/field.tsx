import type { ReactElement, ReactNode } from 'react';
import { STRINGS } from '../../strings.js';

/** How the label and the control sit: stacked, or a label beside a checkbox or a switch. */
export type FieldLayout = 'stacked' | 'checkbox' | 'switch';

export type FieldFrameProps = {
  /** The key the field edits, for tests and for finding the first control. */
  readonly fieldKey: string;
  readonly label: string;
  readonly layout: FieldLayout;
  /** The control is a group (radios, checkboxes): its label names it by id. */
  readonly group: boolean;
  /** Ids the control is bound to: its own, the label's, the hint's and the error's. */
  readonly controlId: string;
  readonly labelId: string;
  readonly hintId: string;
  readonly errorId: string;
  readonly required: boolean;
  /** A required value is still empty: a tag and a border, not an error. */
  readonly needsInput: boolean;
  /** Right-aligned beside the label, such as a slider's current value. */
  readonly trailing?: ReactNode;
  readonly hints: readonly string[];
  readonly error: string | null;
  readonly children: ReactNode;
};

const LABEL = 'text-body font-semibold text-text wrap-anywhere';

/** The "Needs input" tag: text and an outline colour, never colour alone. */
function NeedsInputTag(): ReactElement {
  return (
    <span
      data-needs-input-tag=""
      className="shrink-0 text-caption font-semibold text-attention"
    >
      {STRINGS['panel.needsInput']}
    </span>
  );
}

/**
 * The frame every property control sits in: the label above (or beside a
 * checkbox or switch), the control, its hints in Body muted and its error under
 * it in the destructive colour. The control reads the ids to bind itself to the
 * label and to the hint and error through `aria-describedby`.
 */
export function Field(props: FieldFrameProps): ReactElement {
  const {
    fieldKey,
    label,
    layout,
    group,
    controlId,
    labelId,
    hintId,
    errorId,
    needsInput,
    trailing,
    hints,
    error,
    children,
  } = props;

  const labelNode = group ? (
    <span id={labelId} className={LABEL}>
      {label}
    </span>
  ) : (
    <label id={labelId} htmlFor={controlId} className={LABEL}>
      {label}
    </label>
  );
  const tag = needsInput ? <NeedsInputTag /> : null;

  return (
    <div
      data-field={fieldKey}
      data-needs-input={needsInput ? '' : undefined}
      className="flex flex-col"
    >
      {layout === 'stacked' ? (
        <>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            {labelNode}
            <span className="flex shrink-0 items-baseline gap-2 text-body text-text-muted">
              {trailing}
              {tag}
            </span>
          </div>
          {children}
        </>
      ) : layout === 'checkbox' ? (
        <div className="flex items-center gap-2">
          {children}
          <span className="min-w-0 flex-1">{labelNode}</span>
          {tag}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{labelNode}</span>
          {tag}
          {children}
        </div>
      )}
      {hints.length === 0 ? null : (
        <p
          id={hintId}
          className="m-0 mt-1 text-body text-text-muted wrap-anywhere"
        >
          {hints.join(' ')}
        </p>
      )}
      {error === null ? null : (
        <p
          id={errorId}
          data-field-error=""
          className="m-0 mt-1 text-body text-destructive wrap-anywhere"
        >
          {error}
        </p>
      )}
    </div>
  );
}
