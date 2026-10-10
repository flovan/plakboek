import type { ReactElement } from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import { STRINGS } from '../strings.js';
import {
  FIELD_GROUP,
  FIELD_INPUT,
  FIELD_LABEL,
  LoginCard,
  PRIMARY_BUTTON,
} from './card.js';

export type PasswordLinkStepProps = {
  /** An invitation landing chooses a first password, a reset landing
   * replaces one. Only the words differ. */
  readonly variant: 'set-password' | 'reset-password';
  readonly next: string;
};

/**
 * The set-password and reset-password landings: a new password and its
 * confirmation. The link's token is deliberately not part of this markup;
 * the client reads it from the address bar and removes it there.
 */
export function PasswordLinkStep(props: PasswordLinkStepProps): ReactElement {
  const invite = props.variant === 'set-password';
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
      next={props.next}
    >
      <form method="post" action={CMS_LOGIN_PATH} noValidate>
        <div className={FIELD_GROUP}>
          <label htmlFor="plakboek-login-new-password" className={FIELD_LABEL}>
            {STRINGS['login.password.new.label']}
          </label>
          <input
            id="plakboek-login-new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            aria-describedby="plakboek-login-new-password-hint"
            className={FIELD_INPUT}
          />
          <p
            id="plakboek-login-new-password-hint"
            className="m-0 mt-1 text-body text-text-muted"
          >
            {STRINGS['login.password.new.hint']}
          </p>
        </div>
        <div>
          <label
            htmlFor="plakboek-login-confirm-password"
            className={FIELD_LABEL}
          >
            {STRINGS['login.password.confirm.label']}
          </label>
          <input
            id="plakboek-login-confirm-password"
            name="passwordConfirm"
            type="password"
            autoComplete="new-password"
            className={FIELD_INPUT}
          />
        </div>
        <div className="mt-6">
          <button type="submit" className={PRIMARY_BUTTON}>
            {invite
              ? STRINGS['login.setPassword.submit']
              : STRINGS['login.resetPassword.submit']}
          </button>
        </div>
      </form>
    </LoginCard>
  );
}
