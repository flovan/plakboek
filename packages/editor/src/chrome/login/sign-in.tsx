import type { ReactElement } from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import { STRINGS } from '../strings.js';
import {
  FIELD_GROUP,
  FIELD_INPUT,
  FIELD_LABEL,
  LoginCard,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  TEXT_LINK,
} from './card.js';

export type SignInStepProps = {
  readonly next: string;
};

/**
 * The sign-in step: the markup the server paints and the client later
 * hydrates with behaviour. The form posts to `/cms`, which answers 405, so a
 * browser that never runs the script cannot put a password in an address:
 * signing in needs JavaScript in this release.
 */
export function SignInStep(props: SignInStepProps): ReactElement {
  return (
    <LoginCard heading={STRINGS['login.signIn.heading']} next={props.next}>
      <form method="post" action={CMS_LOGIN_PATH} noValidate>
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
