import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import {
  controlFor,
  instantToLocalInput,
  localInputToInstant,
  parseJsonInput,
  subFieldsOf,
  valueSummary,
  type ControlChoice,
  type ControlDescriptor,
  type ControlHints,
  type ControlSource,
  type SubField,
} from '../../../client/session/control-map.js';
import { formatString, STRINGS } from '../../strings.js';
import { Field, type FieldLayout } from './field.js';
import { RepeaterControl } from './repeater-control.js';

/** Called with the new value (undefined clears it) and whether it applies at once or after a pause. */
export type ChangeHandler = (value: unknown, immediate: boolean) => void;

type LeafProps = {
  readonly id: string;
  readonly labelId: string;
  readonly fieldKey: string;
  readonly descriptor: ControlDescriptor;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly required: boolean;
  /** A required value is empty: the border takes the attention colour. */
  readonly attention: boolean;
  readonly describedBy: string | undefined;
  readonly onChange: ChangeHandler;
  readonly onBlur: () => void;
};

function border(props: {
  readonly invalid: boolean;
  readonly attention: boolean;
}): string {
  if (props.invalid) return 'border-destructive';
  return props.attention ? 'border-attention' : 'border-control-border';
}

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

const INPUT = `box-border h-10 w-full rounded-lg border bg-input-fill px-3 text-body text-text ${FOCUS}`;
const AREA = `box-border w-full resize-y rounded-lg border bg-input-fill px-3 py-2 text-body text-text ${FOCUS}`;

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function aria(props: LeafProps): {
  readonly 'aria-invalid': boolean | undefined;
  readonly 'aria-required': boolean | undefined;
  readonly 'aria-describedby': string | undefined;
} {
  return {
    'aria-invalid': props.invalid ? true : undefined,
    'aria-required': props.required ? true : undefined,
    'aria-describedby': props.describedBy,
  };
}

function TextControl(props: LeafProps): ReactElement {
  const { id, fieldKey, descriptor, value, disabled, onChange, onBlur } = props;
  const kind = descriptor.kind;
  return (
    <input
      id={id}
      data-control={fieldKey}
      type={kind === 'url' ? 'url' : 'text'}
      autoComplete="off"
      spellCheck={false}
      value={stringOf(value)}
      maxLength={descriptor.hints.maxLength}
      disabled={disabled}
      className={`${INPUT} ${border(props)}`}
      {...aria(props)}
      onChange={(event) => {
        onChange(
          event.target.value === '' ? undefined : event.target.value,
          false,
        );
      }}
      onBlur={onBlur}
    />
  );
}

function TextareaControl(props: LeafProps): ReactElement {
  const { id, fieldKey, descriptor, value, disabled, onChange, onBlur } = props;
  return (
    <textarea
      id={id}
      data-control={fieldKey}
      value={stringOf(value)}
      maxLength={descriptor.hints.maxLength}
      disabled={disabled}
      className={`${AREA} min-h-[96px] ${border(props)}`}
      {...aria(props)}
      onChange={(event) => {
        onChange(
          event.target.value === '' ? undefined : event.target.value,
          false,
        );
      }}
      onBlur={onBlur}
    />
  );
}

function NumberControl(props: LeafProps): ReactElement {
  const { id, fieldKey, descriptor, value, disabled, onChange, onBlur } = props;
  const { min, max, step }: ControlHints = descriptor.hints;
  return (
    <input
      id={id}
      data-control={fieldKey}
      type="number"
      value={typeof value === 'number' ? String(value) : ''}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={`${INPUT} ${border(props)}`}
      {...aria(props)}
      onChange={(event) => {
        const text = event.target.value;
        onChange(text === '' ? undefined : Number(text), false);
      }}
      onBlur={onBlur}
    />
  );
}

function RangeControl(props: LeafProps): ReactElement {
  const { id, fieldKey, descriptor, value, disabled, onChange, onBlur } = props;
  const { min, max, step }: ControlHints = descriptor.hints;
  return (
    <input
      id={id}
      data-control={fieldKey}
      type="range"
      value={typeof value === 'number' ? value : (min ?? 0)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={`h-10 w-full cursor-pointer accent-accent ${FOCUS}`}
      {...aria(props)}
      onChange={(event) => {
        onChange(Number(event.target.value), true);
      }}
      onBlur={onBlur}
    />
  );
}

function CheckboxControl(props: LeafProps): ReactElement {
  const { id, fieldKey, value, disabled, onChange, onBlur } = props;
  return (
    <input
      id={id}
      data-control={fieldKey}
      type="checkbox"
      checked={value === true}
      disabled={disabled}
      className={`size-5 shrink-0 cursor-pointer accent-accent ${FOCUS}`}
      {...aria(props)}
      onChange={(event) => {
        onChange(event.target.checked, true);
      }}
      onBlur={onBlur}
    />
  );
}

/** A checkbox drawn as a 40px by 24px track, a checked one filled with the text colour. */
function SwitchControl(props: LeafProps): ReactElement {
  const { id, fieldKey, value, disabled, onChange, onBlur } = props;
  return (
    <input
      id={id}
      data-control={fieldKey}
      type="checkbox"
      role="switch"
      checked={value === true}
      disabled={disabled}
      className={`relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full border border-control-border bg-surface-muted before:absolute before:top-0.5 before:left-0.5 before:size-[18px] before:rounded-full before:bg-text checked:bg-text checked:before:translate-x-4 checked:before:bg-surface ${FOCUS}`}
      {...aria(props)}
      onChange={(event) => {
        onChange(event.target.checked, true);
      }}
      onBlur={onBlur}
    />
  );
}

function SelectControl(props: LeafProps): ReactElement {
  const { id, fieldKey, descriptor, value, disabled, onChange, onBlur } = props;
  const current = stringOf(value);
  const offered: readonly ControlChoice[] =
    current === '' ||
    descriptor.choices.some((entry) => entry.value === current)
      ? descriptor.choices
      : [{ value: current, label: current }, ...descriptor.choices];
  return (
    <select
      id={id}
      data-control={fieldKey}
      value={current}
      disabled={disabled}
      className={`${INPUT} ${border(props)}`}
      {...aria(props)}
      onChange={(event) => {
        onChange(
          event.target.value === '' ? undefined : event.target.value,
          true,
        );
      }}
      onBlur={onBlur}
    >
      <option value="">{STRINGS['panel.none']}</option>
      {offered.map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.label}
        </option>
      ))}
    </select>
  );
}

function RadioControl(props: LeafProps): ReactElement {
  const { id, labelId, fieldKey, descriptor, value, disabled, onChange } =
    props;
  const current = stringOf(value);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={props.describedBy}
      aria-invalid={props.invalid ? true : undefined}
      aria-required={props.required ? true : undefined}
      className={`flex flex-col rounded-lg ${
        props.attention ? 'border border-attention px-3' : ''
      }`}
      onBlur={props.onBlur}
    >
      {descriptor.choices.map((entry) => (
        <label key={entry.value} className="flex h-8 items-center gap-2">
          <input
            type="radio"
            name={id}
            data-control={fieldKey}
            value={entry.value}
            checked={current === entry.value}
            disabled={disabled}
            className={`size-5 shrink-0 cursor-pointer accent-accent ${FOCUS}`}
            onChange={() => {
              onChange(entry.value, true);
            }}
          />
          <span className="text-body text-text wrap-anywhere">
            {entry.label}
          </span>
        </label>
      ))}
    </div>
  );
}

function CheckboxGroupControl(props: LeafProps): ReactElement {
  const { labelId, fieldKey, descriptor, value, disabled, onChange } = props;
  const chosen = Array.isArray(value)
    ? (value as unknown[]).filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={props.describedBy}
      aria-invalid={props.invalid ? true : undefined}
      aria-required={props.required ? true : undefined}
      className={`box-border max-h-48 overflow-y-auto rounded-lg border bg-input-fill px-3 py-1 ${border(props)}`}
      onBlur={props.onBlur}
    >
      {descriptor.choices.map((entry) => (
        <label key={entry.value} className="flex h-8 items-center gap-2">
          <input
            type="checkbox"
            data-control={fieldKey}
            checked={chosen.includes(entry.value)}
            disabled={disabled}
            className={`size-5 shrink-0 cursor-pointer accent-accent ${FOCUS}`}
            onChange={(event) => {
              const next = event.target.checked
                ? [...chosen, entry.value]
                : chosen.filter((item) => item !== entry.value);
              // The stored order is the choices' order, whatever order they were ticked in.
              onChange(
                descriptor.choices
                  .map((choice) => choice.value)
                  .filter((item) => next.includes(item)),
                true,
              );
            }}
          />
          <span className="text-body text-text wrap-anywhere">
            {entry.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * A native date input reports an empty value for a half-filled entry as well
 * as for a cleared one. A half-filled entry is the editor's until it is whole:
 * nothing is sent, and the input is told to show nothing while it is held so
 * the segments already typed are not wiped. Leaving the field drops it, and
 * the saved value is shown again.
 */
function useDateEntry(
  fieldValue: string,
  onChange: (text: string) => void,
  onBlur: () => void,
) {
  const [half, setHalf] = useState(false);
  return {
    value: half ? '' : fieldValue,
    onChange: (event: ChangeEvent<HTMLInputElement>): void => {
      const text = event.target.value;
      if (text === '' && event.target.validity.badInput) {
        setHalf(true);
        return;
      }
      setHalf(false);
      onChange(text);
    },
    onBlur: (): void => {
      setHalf(false);
      onBlur();
    },
  };
}

function DateTimeControl(props: LeafProps): ReactElement {
  const { id, fieldKey, value, disabled, onChange, onBlur } = props;
  const entry = useDateEntry(
    instantToLocalInput(value),
    (text) => {
      onChange(localInputToInstant(text), true);
    },
    onBlur,
  );
  return (
    <input
      id={id}
      data-control={fieldKey}
      type="datetime-local"
      value={entry.value}
      disabled={disabled}
      className={`${INPUT} ${border(props)}`}
      {...aria(props)}
      onChange={entry.onChange}
      onBlur={entry.onBlur}
    />
  );
}

function DateControl(props: LeafProps): ReactElement {
  const { id, fieldKey, value, disabled, onChange, onBlur } = props;
  const entry = useDateEntry(
    stringOf(value).slice(0, 10),
    (text) => {
      onChange(text === '' ? undefined : text, true);
    },
    onBlur,
  );
  return (
    <input
      id={id}
      data-control={fieldKey}
      type="date"
      value={entry.value}
      disabled={disabled}
      className={`${INPUT} ${border(props)}`}
      {...aria(props)}
      onChange={entry.onChange}
      onBlur={entry.onBlur}
    />
  );
}

function jsonText(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/**
 * A monospace textarea for any value that is JSON. What the editor types is
 * theirs until it parses: text that does not parse reports the syntax error
 * and sends nothing, and a value that changes from outside (an undo) replaces
 * the text.
 */
function JsonControl(
  props: LeafProps & { readonly onSyntax: (broken: boolean) => void },
): ReactElement {
  const { id, fieldKey, value, disabled, onChange, onBlur, onSyntax } = props;
  const [text, setText] = useState(() => jsonText(value));
  const latest = useRef(text);
  latest.current = text;
  const shown = JSON.stringify(value);
  useEffect(() => {
    const typed =
      latest.current.trim() === ''
        ? { ok: true as const, value: undefined }
        : parseJsonInput(latest.current);
    // Only a change of the value itself can reset what was typed, and not
    // when the typed text already means that value.
    if (!(typed.ok && JSON.stringify(typed.value) === shown)) {
      setText(jsonText(value));
      onSyntax(false);
    }
  }, [shown]);
  return (
    <textarea
      id={id}
      data-control={fieldKey}
      value={text}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      disabled={disabled}
      className={`${AREA} min-h-[160px] font-mono ${border(props)}`}
      {...aria(props)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') {
          onSyntax(false);
          onChange(undefined, false);
          return;
        }
        const parsed = parseJsonInput(next);
        onSyntax(!parsed.ok);
        if (parsed.ok) onChange(parsed.value, false);
      }}
      onBlur={onBlur}
    />
  );
}

/** A property the editor cannot change yet: what it holds and where it will be edited. */
function NoteControl(props: {
  readonly id: string;
  readonly kind: 'note-rich-text' | 'note-media' | 'note-entry';
  readonly value: unknown;
  readonly attention: boolean;
  readonly describedBy: string | undefined;
}): ReactElement {
  const { kind } = props;
  const note =
    kind === 'note-rich-text'
      ? STRINGS['panel.richTextNote']
      : kind === 'note-media'
        ? STRINGS['panel.mediaNote']
        : STRINGS['panel.entryNote'];
  return (
    <div
      id={props.id}
      data-note={kind}
      aria-describedby={props.describedBy}
      className={`box-border flex flex-col gap-1 rounded-lg border bg-surface-muted px-3 py-2 text-body ${
        props.attention ? 'border-attention' : 'border-border'
      }`}
    >
      {kind === 'note-rich-text' ? null : (
        <span
          data-note-value=""
          className="font-semibold text-text wrap-anywhere"
        >
          {valueSummary(props.value, STRINGS['panel.none'])}
        </span>
      )}
      <span className="text-text-muted wrap-anywhere">{note}</span>
    </div>
  );
}

export type PropertyFieldProps = {
  /** The key the field edits; a repeater's sub-field prefixes its row. */
  readonly fieldKey: string;
  readonly label: string;
  readonly description?: string;
  readonly source: ControlSource;
  readonly required: boolean;
  /** The value shown: the editor's draft, the stored value, or the fixed one. */
  readonly value: unknown;
  readonly needsInput: boolean;
  /** The message under the field, or null. */
  readonly error: string | null;
  readonly onChange: ChangeHandler;
  readonly onBlur: () => void;
};

function layoutOf(kind: ControlDescriptor['kind']): FieldLayout {
  if (kind === 'checkbox') return 'checkbox';
  if (kind === 'switch') return 'switch';
  return 'stacked';
}

/** The JSON control stands in for a host widget on a field type with no standard control. */
function isJsonFallback(descriptor: ControlDescriptor): boolean {
  return descriptor.kind === 'json' && descriptor.customWidget;
}

function hintsOf(
  props: PropertyFieldProps,
  descriptor: ControlDescriptor,
): readonly string[] {
  const { source } = props;
  const hints: string[] = [];
  if (props.description !== undefined) hints.push(props.description);
  if (source.constraint === 'fixed') hints.push(STRINGS['panel.fixedHint']);
  if (descriptor.kind === 'slug') hints.push(STRINGS['panel.slugHint']);
  // A narrowed choice is shown by offering only those choices; free text names them.
  if (
    source.constraint === 'narrowed' &&
    source.allowedValues !== undefined &&
    descriptor.choices.length === 0
  ) {
    hints.push(
      formatString('panel.allowedHint', {
        values: source.allowedValues.join(', '),
      }),
    );
  }
  if (isJsonFallback(descriptor)) {
    hints.push(STRINGS['panel.customWidgetJsonNote']);
    hints.push(STRINGS['panel.jsonFallbackHint']);
  } else if (descriptor.customWidget) {
    hints.push(STRINGS['panel.customWidgetNote']);
  }
  return hints;
}

/**
 * One property as a labelled field with the control its widget maps to, bound
 * to its hint and error. A fixed property is disabled; a hidden one never gets
 * here (it is not in the catalogue). The same component draws a repeater's
 * sub-fields.
 */
export function PropertyField(props: PropertyFieldProps): ReactElement {
  const { fieldKey, label, source, value, required, needsInput } = props;
  const base = useId();
  // Text that is not JSON is the control's to report: it never reaches the server.
  const [syntaxBroken, setSyntaxBroken] = useState(false);
  const descriptor = controlFor(source);
  const error = syntaxBroken
    ? isJsonFallback(descriptor)
      ? STRINGS['panel.jsonFallbackError']
      : STRINGS['panel.jsonError']
    : props.error;
  const { kind } = descriptor;
  const hints = hintsOf(props, descriptor);
  const ids = {
    control: `${base}-control`,
    label: `${base}-label`,
    hint: `${base}-hint`,
    error: `${base}-error`,
  };
  const describedBy =
    [hints.length > 0 ? ids.hint : null, error === null ? null : ids.error]
      .filter((entry) => entry !== null)
      .join(' ') || undefined;
  const disabled = source.constraint === 'fixed';
  const leaf: LeafProps = {
    id: ids.control,
    labelId: ids.label,
    fieldKey,
    descriptor,
    value,
    disabled,
    invalid: error !== null,
    required,
    attention: needsInput,
    describedBy,
    onChange: props.onChange,
    onBlur: props.onBlur,
  };
  const group =
    kind === 'radio' || kind === 'checkbox-group' || kind === 'repeater';

  let control: ReactElement;
  switch (kind) {
    case 'text':
    case 'url':
    case 'slug':
      control = <TextControl {...leaf} />;
      break;
    case 'textarea':
      control = <TextareaControl {...leaf} />;
      break;
    case 'number':
      control = <NumberControl {...leaf} />;
      break;
    case 'range':
      control = <RangeControl {...leaf} />;
      break;
    case 'checkbox':
      control = <CheckboxControl {...leaf} />;
      break;
    case 'switch':
      control = <SwitchControl {...leaf} />;
      break;
    case 'select':
      control = <SelectControl {...leaf} />;
      break;
    case 'radio':
      control = <RadioControl {...leaf} />;
      break;
    case 'checkbox-group':
      control = <CheckboxGroupControl {...leaf} />;
      break;
    case 'datetime':
      control = <DateTimeControl {...leaf} />;
      break;
    case 'date':
      control = <DateControl {...leaf} />;
      break;
    case 'json':
      control = <JsonControl {...leaf} onSyntax={setSyntaxBroken} />;
      break;
    case 'repeater':
      control = (
        <RepeaterControl
          labelId={ids.label}
          describedBy={describedBy}
          value={value}
          disabled={disabled}
          invalid={error !== null}
          attention={needsInput}
          subFields={subFieldsOf(source.options)}
          onChange={props.onChange}
          onBlur={props.onBlur}
          renderSubField={(sub: SubField, row, rowValue, change) => (
            <PropertyField
              key={`${row}:${sub.key}`}
              fieldKey={`${fieldKey}.${String(row)}.${sub.key}`}
              label={sub.label}
              source={sub.source}
              required={sub.required}
              value={rowValue}
              needsInput={false}
              error={null}
              onChange={change}
              onBlur={props.onBlur}
            />
          )}
        />
      );
      break;
    case 'note-rich-text':
    case 'note-media':
    case 'note-entry':
      control = (
        <NoteControl
          id={ids.control}
          kind={kind}
          value={value}
          attention={needsInput}
          describedBy={describedBy}
        />
      );
      break;
  }

  return (
    <Field
      fieldKey={fieldKey}
      label={label}
      layout={layoutOf(kind)}
      group={group || kind.startsWith('note-')}
      controlId={ids.control}
      labelId={ids.label}
      hintId={ids.hint}
      errorId={ids.error}
      required={required}
      needsInput={needsInput}
      trailing={
        kind === 'range' && typeof value === 'number' ? (
          <span data-range-value="">{value}</span>
        ) : undefined
      }
      hints={hints}
      error={error}
    >
      {control}
    </Field>
  );
}
