import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  failureMessage,
  normaliseEmail,
  validateEmail,
  type AuthFailure,
} from '../../client/login/validation.js';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour, type LinkRequestResult } from './behaviour.js';
import { Field, ErrorBox, PrimaryButton } from './fields.js';

/** A text field's value from a submitted form. */
function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

type Failure = { readonly failure: AuthFailure; readonly attempt: number };

export type RequestLinkFormProps = {
  /** Asks the service to email the link. */
  readonly send: (
    email: string,
  ) => Promise<LinkRequestResult> | LinkRequestResult;
  /** The label of the primary button. */
  readonly submitLabel: string;
  /** The request went through: the address that was typed, as it was sent. */
  readonly onSent: (email: string) => void;
};

/**
 * The form both request steps (forgot password and sign-in link) share: an
 * email field, the one primary button and the single error box. A malformed
 * address is caught before anything is sent; after that the answer is the
 * same for every address, so the form moves on without learning anything
 * about the account. A rate-limited, failed or unreachable service shows its
 * message in the box and keeps the typed address.
 */
export function RequestLinkForm(props: RequestLinkFormProps): ReactElement {
  const { send, submitLabel, onSent } = props;
  const behaviour = useLoginBehaviour();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (behaviour === null || busyRef.current) return;
    const email = normaliseEmail(
      fieldText(new FormData(event.currentTarget), 'email'),
    );
    const problem = validateEmail(email);
    setEmailError(problem);
    setFailed(null);
    if (problem !== null) {
      emailRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const result = await send(email);
    if (result.status === 'sent') {
      onSent(email);
      return;
    }
    setFailed((previous) => ({
      failure: result.failure,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field
        id="plakboek-login-email"
        name="email"
        label={STRINGS['login.signIn.email.label']}
        type="email"
        autoComplete="username"
        autoFocus
        readOnly={busy}
        error={emailError}
        inputRef={emailRef}
      />
      <div className="mt-6">
        {failed === null ? null : (
          <ErrorBox
            key={failed.attempt}
            message={failureMessage(failed.failure)}
          />
        )}
        <PrimaryButton busy={busy} busyLabel={STRINGS['loading.sending']}>
          {submitLabel}
        </PrimaryButton>
      </div>
    </form>
  );
}
