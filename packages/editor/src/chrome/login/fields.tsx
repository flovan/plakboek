import {
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { AlertIcon, SpinnerIcon } from '../icons.js';
import { FIELD_INPUT, FIELD_LABEL, PRIMARY_BUTTON } from './card.js';

export type FieldProps = {
  /** The input's id; its hint and error are `<id>-hint` and `<id>-error`. */
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly type?: 'text' | 'email' | 'password';
  readonly autoComplete: string;
  readonly autoFocus?: boolean;
  readonly inputMode?: 'numeric';
  readonly maxLength?: number;
  /** Help under the field, bound to it as its description. */
  readonly hint?: string;
  /** The inline message for this field; marks it invalid when present. */
  readonly error?: string | null;
  /** The field cannot be edited (a request is in flight). */
  readonly readOnly?: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
  /** Classes of the wrapper, for the space below the field. */
  readonly className?: string;
};

/**
 * A labelled input with an optional hint and an inline error. The label is
 * always visible and bound to the input; hint and error are bound by
 * `aria-describedby`, and an error also sets `aria-invalid`. The input is
 * uncontrolled, so what was typed before the script arrived survives
 * hydration. Without a hint or an error the markup is exactly a label and an
 * input.
 */
export function Field(props: FieldProps): ReactElement {
  const {
    id,
    name,
    label,
    type = 'text',
    autoComplete,
    autoFocus,
    inputMode,
    maxLength,
    hint,
    error,
    readOnly,
    inputRef,
    className,
  } = props;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [
    hint === undefined ? null : hintId,
    error === undefined || error === null ? null : errorId,
  ].filter((value) => value !== null);
  return (
    <div className={className}>
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        inputMode={inputMode}
        maxLength={maxLength}
        readOnly={readOnly}
        ref={inputRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          described.length > 0 ? described.join(' ') : undefined
        }
        className={FIELD_INPUT}
      />
      {hint === undefined ? null : (
        <p
          id={hintId}
          className="m-0 mt-1 text-body text-text-muted wrap-anywhere"
        >
          {hint}
        </p>
      )}
      {error ? (
        <p
          id={errorId}
          className="m-0 mt-1 text-body text-destructive wrap-anywhere"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type PrimaryButtonProps = {
  readonly children: ReactNode;
  /** A request is in flight: the in-flight word replaces the label. */
  readonly busy?: boolean;
  /** The word shown while in flight ("Signing in", "Verifying", ...). */
  readonly busyLabel: string;
};

/**
 * The one primary button of a step. In flight it shows a 16px spinner and the
 * in-flight word, is `disabled` and keeps `aria-disabled` so the label is
 * still read; the spinner is a still arc under reduced motion.
 */
export function PrimaryButton(props: PrimaryButtonProps): ReactElement {
  const { children, busy = false, busyLabel } = props;
  return (
    <button
      type="submit"
      disabled={busy}
      aria-disabled={busy ? true : undefined}
      className={PRIMARY_BUTTON}
    >
      {busy ? <SpinnerIcon size={16} /> : null}
      {busy ? busyLabel : children}
    </button>
  );
}

/**
 * The one error box of a step, for a failure the server or the network
 * caused. It is an alert, takes focus when it appears and shows an icon next
 * to the message, so colour is never the only signal.
 */
export function ErrorBox(props: { readonly message: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mb-4 flex items-start gap-2 rounded-lg border border-destructive p-4 text-body text-destructive wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <AlertIcon size={16} className="mt-1 shrink-0" />
      <span>{props.message}</span>
    </div>
  );
}
