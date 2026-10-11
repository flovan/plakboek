import { useRef, useState, type ReactElement } from 'react';
import { TWO_FACTOR_MAX_ATTEMPTS } from '../../client/login/validation.js';
import type { LinkKind, LoginStep } from '../island.js';
import {
  LoginBehaviourContext,
  StepFocusContext,
  type LoginBehaviour,
} from './behaviour.js';
import { EnrolStep } from './enrol.js';
import { ForgotStep } from './forgot.js';
import { InvalidLinkStep } from './invalid-link.js';
import { LockoutStep } from './lockout.js';
import { MagicLandingStep } from './magic-landing.js';
import { MagicRequestStep } from './magic-request.js';
import { PasswordLinkStep } from './password-link.js';
import { SentState } from './sent.js';
import { SignInStep, type SignInStatus } from './sign-in.js';
import { EmailCodeStep, TwoFactorStep } from './two-factor.js';

/** What the card shows: a step the page opened on, or one it reached by
 * signing in. */
export type LoginView =
  | LoginStep
  | 'two-factor-totp'
  | 'two-factor-email'
  | 'lockout'
  | 'forgot'
  | 'forgot-sent'
  | 'magic-request'
  | 'magic-sent';

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
 * when the account is locked or five wrong codes have been entered. The
 * request steps (forgot password, sign-in link) end in one shared "Check your
 * email" state, the password landings return to sign-in with a status line,
 * and an unusable link ends in the invalid-link step whose button leads to the
 * request step that can replace it. Each step after the first takes focus on
 * its heading.
 */
export function LoginApp(props: LoginAppProps): ReactElement {
  const { step, next, behaviour } = props;
  const [view, setView] = useState<LoginView>(step);
  // The kind of link the invalid-link step stands in for. A landing that
  // finds its link unusable sets it before moving there.
  const [linkKind, setLinkKind] = useState<LinkKind>(
    props.linkKind ?? 'sign-in',
  );
  // The line above the sign-in form after a password was set or reset.
  const [status, setStatus] = useState<SignInStatus | null>(null);
  // The address a link was requested for, repeated in the sent state.
  const [sentTo, setSentTo] = useState('');
  // Once the card has left the step the page opened on, every new step
  // focuses its heading.
  const [moved, setMoved] = useState(false);
  // The address the sign-in was started with, for the emailed-code step.
  const [email, setEmail] = useState('');
  // Wrong codes since the sign-in began. The server locks the account after
  // `TWO_FACTOR_MAX_ATTEMPTS` of them, so that many in a row end in lockout.
  const wrongCodes = useRef(0);

  function go(to: LoginView, nextStatus: SignInStatus | null = null): void {
    setMoved(true);
    setStatus(nextStatus);
    setView(to);
  }

  /** An unusable link of this kind: the shared invalid-link step. */
  function invalid(kind: LinkKind): void {
    setLinkKind(kind);
    go('invalid-link');
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
            status={status}
            onForgot={() => {
              go('forgot');
            }}
            onMagicLink={() => {
              go('magic-request');
            }}
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
      case 'forgot':
        return (
          <ForgotStep
            next={next}
            onSent={(typed) => {
              setSentTo(typed);
              go('forgot-sent');
            }}
            onBack={() => {
              go('sign-in');
            }}
          />
        );
      case 'magic-request':
        return (
          <MagicRequestStep
            next={next}
            onSent={(typed) => {
              setSentTo(typed);
              go('magic-sent');
            }}
            onBack={() => {
              go('sign-in');
            }}
          />
        );
      case 'forgot-sent':
      case 'magic-sent':
        return (
          <SentState
            kind={view === 'forgot-sent' ? 'reset' : 'sign-in'}
            email={sentTo}
            next={next}
            onBack={() => {
              go('sign-in');
            }}
          />
        );
      case 'set-password':
      case 'reset-password':
        return (
          <PasswordLinkStep
            variant={view}
            next={next}
            onDone={() => {
              go(
                'sign-in',
                view === 'set-password' ? 'password-set' : 'password-reset',
              );
            }}
            onInvalid={() => {
              invalid(view === 'set-password' ? 'invite' : 'reset');
            }}
          />
        );
      case 'magic-landing':
        return (
          <MagicLandingStep
            next={next}
            onInvalid={() => {
              invalid('sign-in');
            }}
          />
        );
      case 'invalid-link':
        return (
          <InvalidLinkStep
            linkKind={linkKind}
            next={next}
            onAction={() => {
              go(
                linkKind === 'reset'
                  ? 'forgot'
                  : linkKind === 'sign-in'
                    ? 'magic-request'
                    : 'sign-in',
              );
            }}
          />
        );
      case 'enrol':
        return <EnrolStep {...handlers} />;
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
