import type { ReactElement } from 'react';
import { CMS_LOGIN_PATH } from '@plakboek/render';
import { STRINGS } from '../strings.js';
import { FIELD_INPUT, FIELD_LABEL, LoginCard, PRIMARY_BUTTON } from './card.js';

export type EnrolStepProps = {
  readonly next: string;
};

/**
 * The first sub-step of two-step sign-in set-up for a role that requires it:
 * confirm the password. The key, the code and the backup codes follow in the
 * client once it is running.
 */
export function EnrolStep(props: EnrolStepProps): ReactElement {
  return (
    <LoginCard
      heading={STRINGS['enrol.confirm.heading']}
      body={STRINGS['enrol.confirm.body']}
      next={props.next}
    >
      <form method="post" action={CMS_LOGIN_PATH} noValidate>
        <div>
          <label
            htmlFor="plakboek-login-enrol-password"
            className={FIELD_LABEL}
          >
            {STRINGS['login.signIn.password.label']}
          </label>
          <input
            id="plakboek-login-enrol-password"
            name="password"
            type="password"
            autoComplete="current-password"
            className={FIELD_INPUT}
          />
        </div>
        <div className="mt-6">
          <button type="submit" className={PRIMARY_BUTTON}>
            {STRINGS['enrol.confirm.submit']}
          </button>
        </div>
      </form>
    </LoginCard>
  );
}
