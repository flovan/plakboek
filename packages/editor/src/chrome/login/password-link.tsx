import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import { takeLinkToken } from '../../client/login/link-token.js';
import {
  failureMessage,
  validateNewPassword,
  validatePasswordConfirmation,
  type AuthFailure,
} from '../../client/login/validation.js';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour } from './behaviour.js';
import { FIELD_GROUP, LoginCard } from './card.js';
import { ErrorBox, Field, PrimaryButton } from './fields.js';

/** A text field's value from a submitted form. */
function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export type PasswordLinkStepProps = {
  /** An invitation landing chooses a first password, a reset landing
   * replaces one. Only the words and the purpose sent differ. */
  readonly variant: 'set-password' | 'reset-password';
  readonly next: string;
  /** The password is set: back to sign-in, with the matching status line. */
  readonly onDone?: () => void;
  /** The link has no token, or the service refused it: the invalid-link step. */
  readonly onInvalid?: () => void;
};

type Failure = { readonly failure: AuthFailure; readonly attempt: number };

/**
 * The set-password and reset-password landings: a new password and its
 * confirmation. The link's token is deliberately not part of the markup the
 * server paints; on mount the client takes it out of the address bar (and so
 * out of the history and any later Referer) and keeps it only here, in a ref,
 * until the form is submitted. An address that had no token goes straight to
 * the invalid-link step.
 *
 * Length and agreement are checked before anything is sent and show under the
 * field. A password the service finds too short shows the same message and
 * leaves the link usable; an unusable link moves to the invalid-link step; any
 * other failure shows in the error box. Both password fields are cleared after
 * a refusal.
 */
export function PasswordLinkStep(props: PasswordLinkStepProps): ReactElement {
  const { variant, next, onDone, onInvalid } = props;
  const invite = variant === 'set-password';
  const behaviour = useLoginBehaviour();
  // `undefined` until the address has been read; a second read (a repeated
  // effect) must not mistake the removed token for a missing one.
  const tokenRef = useRef<string | null | undefined>(undefined);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (behaviour === null) return;
    tokenRef.current ??= takeLinkToken();
    if (tokenRef.current === null) onInvalid?.();
    // Runs once: `behaviour` is made once for the life of the root.
  }, [behaviour]);

  function clearPasswords(): void {
    if (passwordRef.current !== null) passwordRef.current.value = '';
    if (confirmRef.current !== null) confirmRef.current.value = '';
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (behaviour === null || busyRef.current) return;
    const form = new FormData(event.currentTarget);
    const password = fieldText(form, 'password');
    const confirmation = fieldText(form, 'passwordConfirm');

    const lengthProblem = validateNewPassword(password);
    const matchProblem = validatePasswordConfirmation(password, confirmation);
    setPasswordError(lengthProblem);
    setConfirmError(lengthProblem === null ? matchProblem : null);
    setFailed(null);
    if (lengthProblem !== null || matchProblem !== null) {
      (lengthProblem === null ? confirmRef : passwordRef).current?.focus();
      return;
    }
    const token = tokenRef.current;
    if (token === null || token === undefined) {
      onInvalid?.();
      return;
    }

    busyRef.current = true;
    setBusy(true);
    const result = await behaviour.auth.completePasswordLink(
      variant,
      token,
      password,
    );
    if (result.status === 'done') {
      onDone?.();
      return;
    }
    if (result.status === 'invalid-link') {
      onInvalid?.();
      return;
    }
    clearPasswords();
    if (result.status === 'too-short') {
      // The link was not spent: the same token is still the right one.
      setPasswordError(STRINGS['validation.newPassword.tooShort']);
      passwordRef.current?.focus();
    } else {
      setFailed((previous) => ({
        failure: result.failure,
        attempt: (previous?.attempt ?? 0) + 1,
      }));
    }
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <LoginCard
      heading={
        invite
          ? STRINGS['login.setPassword.heading']
          : STRINGS['login.resetPassword.heading']
      }
      body={
        invite
          ? STRINGS['login.setPassword.body']
          : STRINGS['login.resetPassword.body']
      }
      next={next}
    >
      <form
        method="post"
        action={CMS_LOGIN_PATH}
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          id="plakboek-login-new-password"
          name="password"
          label={STRINGS['login.password.new.label']}
          type="password"
          autoComplete="new-password"
          autoFocus
          hint={STRINGS['login.password.new.hint']}
          readOnly={busy}
          error={passwordError}
          inputRef={passwordRef}
          className={FIELD_GROUP}
        />
        <Field
          id="plakboek-login-confirm-password"
          name="passwordConfirm"
          label={STRINGS['login.password.confirm.label']}
          type="password"
          autoComplete="new-password"
          readOnly={busy}
          error={confirmError}
          inputRef={confirmRef}
        />
        <div className="mt-6">
          {failed === null ? null : (
            <ErrorBox
              key={failed.attempt}
              message={failureMessage(failed.failure)}
            />
          )}
          <PrimaryButton busy={busy} busyLabel={STRINGS['loading.saving']}>
            {invite
              ? STRINGS['login.setPassword.submit']
              : STRINGS['login.resetPassword.submit']}
          </PrimaryButton>
        </div>
      </form>
    </LoginCard>
  );
}
