import { useRef, useState, type ReactElement } from 'react';
import { TWO_FACTOR_MAX_ATTEMPTS } from '../../client/login/validation.js';
import type { LinkKind, LoginStep } from '../island.js';
import {
  LoginBehaviourContext,
  StepFocusContext,
  type LoginBehaviour,
} from './behaviour.js';
import { EnrolStep } from './enrol.js';
import { InvalidLinkStep } from './invalid-link.js';
import { LockoutStep } from './lockout.js';
import { MagicLandingStep } from './magic-landing.js';
import { PasswordLinkStep } from './password-link.js';
import { SignInStep } from './sign-in.js';
import { EmailCodeStep, TwoFactorStep } from './two-factor.js';

/** What the card shows: a step the page opened on, or one it reached by
 * signing in. */
export type LoginView =
  | LoginStep
  | 'two-factor-totp'
  | 'two-factor-email'
  | 'lockout';

export type LoginAppProps = {
  readonly step: LoginStep;
  /** The same-origin page behind the card and the "Back to site" target. */
  readonly next: string;
  /** Which kind of link an `invalid-link` step stands in for. */
  readonly linkKind?: LinkKind;
  /** What the client adds to make the card work; absent on the server, where
   * every step is static markup. */
  readonly behaviour?: LoginBehaviour;
};

/**
 * The login card and the state machine behind it. The server renders it to
 * markup for the first paint (the step the page opened on, with no behaviour)
 * and the client hydrates it from the same island, so one component serves
 * both. In the client a sign-in moves it on: password to the authenticator
 * step, from there to the emailed-code step and back, and to the lockout step
 * when the account is locked or five wrong codes have been entered. Each step
 * after the first takes focus on its heading.
 */
export function LoginApp(props: LoginAppProps): ReactElement {
  const { step, next, linkKind = 'sign-in', behaviour } = props;
  const [view, setView] = useState<LoginView>(step);
  // Once the card has left the step the page opened on, every new step
  // focuses its heading.
  const [moved, setMoved] = useState(false);
  // The address the sign-in was started with, for the emailed-code step.
  const [email, setEmail] = useState('');
  // Wrong codes since the sign-in began. The server locks the account after
  // `TWO_FACTOR_MAX_ATTEMPTS` of them, so that many in a row end in lockout.
  const wrongCodes = useRef(0);

  function go(to: LoginView): void {
    setMoved(true);
    setView(to);
  }

  const handlers = {
    next,
    onWrongCode: () => {
      wrongCodes.current += 1;
      return wrongCodes.current >= TWO_FACTOR_MAX_ATTEMPTS;
    },
    onLockout: () => {
      go('lockout');
    },
  };

  function body(): ReactElement {
    switch (view) {
      case 'sign-in':
        return (
          <SignInStep
            next={next}
            onTwoFactor={(typed) => {
              wrongCodes.current = 0;
              setEmail(typed);
              go('two-factor-totp');
            }}
          />
        );
      case 'two-factor-totp':
        return (
          <TwoFactorStep
            {...handlers}
            onEmailSent={() => {
              go('two-factor-email');
            }}
          />
        );
      case 'two-factor-email':
        return (
          <EmailCodeStep
            {...handlers}
            email={email}
            onUseAuthenticator={() => {
              go('two-factor-totp');
            }}
          />
        );
      case 'lockout':
        return (
          <LockoutStep
            next={next}
            onBack={() => {
              wrongCodes.current = 0;
              go('sign-in');
            }}
          />
        );
      case 'set-password':
      case 'reset-password':
        return <PasswordLinkStep variant={view} next={next} />;
      case 'magic-landing':
        return <MagicLandingStep next={next} />;
      case 'invalid-link':
        return <InvalidLinkStep linkKind={linkKind} next={next} />;
      case 'enrol':
        return <EnrolStep next={next} />;
    }
  }

  return (
    <LoginBehaviourContext.Provider value={behaviour ?? null}>
      <StepFocusContext.Provider value={moved}>
        {body()}
      </StepFocusContext.Provider>
    </LoginBehaviourContext.Provider>
  );
}
