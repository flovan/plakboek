import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import {
  failureMessage,
  validateEmail,
  validatePassword,
  type AuthFailure,
} from '../../client/login/validation.js';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour } from './behaviour.js';
import { FIELD_GROUP, LoginCard, SECONDARY_BUTTON, TEXT_LINK } from './card.js';
import { ErrorBox, Field, PrimaryButton } from './fields.js';

/** A text field's value from a submitted form. */
function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Which password change the card has just finished, for the line above the
 * form that tells the person to sign in. */
export type SignInStatus = 'password-set' | 'password-reset';

export type SignInStepProps = {
  readonly next: string;
  /** A set-password or reset-password step just finished. */
  readonly status?: SignInStatus | null;
  /** The person asked to reset a forgotten password. */
  readonly onForgot?: () => void;
  /** The person asked for a sign-in link. */
  readonly onMagicLink?: () => void;
  /** The password was right and a second factor is needed; called with the
   * address that was typed, so the emailed-code step can name it. */
  readonly onTwoFactor?: (email: string) => void;
};

/** What one failed attempt shows: the message and a count, so the same
 * failure twice in a row still gives the box a new element to focus. */
type Failure = { readonly failure: AuthFailure; readonly attempt: number };

/**
 * The sign-in step: the markup the server paints and the client later
 * hydrates with behaviour. The form posts to `/cms`, which answers 405, so a
 * browser that never runs the script cannot put a password in an address:
 * signing in needs JavaScript in this release.
 *
 * Problems the card can see (an empty or malformed address, an empty
 * password) show under their field before anything is sent. A refused or
 * failed request shows in one alert box above the button, which takes focus;
 * the password is cleared, the address kept, and the words never say which of
 * the two was wrong. While a request is in flight the inputs are read-only
 * and a second submit is ignored.
 */
export function SignInStep(props: SignInStepProps): ReactElement {
  const { next, status, onForgot, onMagicLink, onTwoFactor } = props;
  const behaviour = useLoginBehaviour();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // A second submit while one is in flight is ignored.
    if (behaviour === null || busyRef.current) return;
    const form = new FormData(event.currentTarget);
    const email = fieldText(form, 'email').trim();
    const password = fieldText(form, 'password');

    const emailProblem = validateEmail(email);
    const passwordProblem = validatePassword(password);
    setEmailError(emailProblem);
    setPasswordError(passwordProblem);
    setFailed(null);
    if (emailProblem !== null || passwordProblem !== null) {
      (emailProblem === null ? passwordRef : emailRef).current?.focus();
      return;
    }

    busyRef.current = true;
    setBusy(true);
    const result = await behaviour.auth.signInEmail(email, password);
    if (result.status === 'signed-in') {
      // The card stays as it is while the hand-over takes it.
      behaviour.signedIn(result.user);
      return;
    }
    if (result.status === 'two-factor') {
      onTwoFactor?.(email);
      return;
    }
    if (passwordRef.current !== null) passwordRef.current.value = '';
    setFailed((previous) => ({
      failure: result.failure,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <LoginCard heading={STRINGS['login.signIn.heading']} next={next}>
      <form
        method="post"
        action={CMS_LOGIN_PATH}
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {status === undefined || status === null ? null : (
          <p
            role="status"
            className="m-0 mb-4 text-body text-text wrap-anywhere"
          >
            {status === 'password-set'
              ? STRINGS['login.signIn.status.passwordSet']
              : STRINGS['login.signIn.status.passwordReset']}
          </p>
        )}
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
          className={FIELD_GROUP}
        />
        <Field
          id="plakboek-login-password"
          name="password"
          label={STRINGS['login.signIn.password.label']}
          type="password"
          autoComplete="current-password"
          readOnly={busy}
          error={passwordError}
          inputRef={passwordRef}
        />
        <div className="mt-2 text-right">
          <button type="button" onClick={onForgot} className={TEXT_LINK}>
            {STRINGS['login.signIn.forgot']}
          </button>
        </div>
        <div className="mt-6">
          {failed === null ? null : (
            <ErrorBox
              key={failed.attempt}
              message={failureMessage(failed.failure)}
            />
          )}
          <PrimaryButton busy={busy} busyLabel={STRINGS['loading.signingIn']}>
            {STRINGS['login.signIn.submit']}
          </PrimaryButton>
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={onMagicLink}
            className={SECONDARY_BUTTON}
          >
            {STRINGS['login.signIn.magicLink']}
          </button>
        </div>
      </form>
    </LoginCard>
  );
}
