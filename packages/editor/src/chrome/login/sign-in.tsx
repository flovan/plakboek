import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour } from './behaviour.js';
import {
  FIELD_GROUP,
  FIELD_INPUT,
  FIELD_LABEL,
  LoginCard,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  TEXT_LINK,
} from './card.js';

/** A text field's value from a submitted form. */
function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export type SignInStepProps = {
  readonly next: string;
};

/**
 * The sign-in step: the markup the server paints and the client later
 * hydrates with behaviour. The form posts to `/cms`, which answers 405, so a
 * browser that never runs the script cannot put a password in an address:
 * signing in needs JavaScript in this release. The inputs are uncontrolled,
 * so whatever was typed before the script arrived survives hydration.
 */
export function SignInStep(props: SignInStepProps): ReactElement {
  const behaviour = useLoginBehaviour();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // A second submit while one is in flight is ignored.
    if (behaviour === null || busyRef.current) return;
    const form = new FormData(event.currentTarget);
    const email = fieldText(form, 'email').trim();
    const password = fieldText(form, 'password');
    busyRef.current = true;
    setBusy(true);
    const result = await behaviour.auth.signInEmail(email, password);
    if (result.status === 'signed-in') {
      // The card stays as it is while the hand-over takes it.
      behaviour.signedIn(result.user);
      return;
    }
    if (passwordRef.current !== null) passwordRef.current.value = '';
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <LoginCard heading={STRINGS['login.signIn.heading']} next={props.next}>
      <form
        method="post"
        action={CMS_LOGIN_PATH}
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className={FIELD_GROUP}>
          <label htmlFor="plakboek-login-email" className={FIELD_LABEL}>
            {STRINGS['login.signIn.email.label']}
          </label>
          <input
            id="plakboek-login-email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            readOnly={busy}
            className={FIELD_INPUT}
          />
        </div>
        <div>
          <label htmlFor="plakboek-login-password" className={FIELD_LABEL}>
            {STRINGS['login.signIn.password.label']}
          </label>
          <input
            id="plakboek-login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            ref={passwordRef}
            readOnly={busy}
            className={FIELD_INPUT}
          />
        </div>
        <div className="mt-2 text-right">
          <button type="button" data-action="forgot" className={TEXT_LINK}>
            {STRINGS['login.signIn.forgot']}
          </button>
        </div>
        <div className="mt-6">
          <button type="submit" className={PRIMARY_BUTTON}>
            {STRINGS['login.signIn.submit']}
          </button>
        </div>
        <div className="mt-4">
          <button
            type="button"
            data-action="magic-link"
            className={SECONDARY_BUTTON}
          >
            {STRINGS['login.signIn.magicLink']}
          </button>
        </div>
      </form>
    </LoginCard>
  );
}
