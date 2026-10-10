import type { ReactElement } from 'react';
import type { LinkKind, LoginStep } from '../island.js';
import { LoginBehaviourContext, type LoginBehaviour } from './behaviour.js';
import { EnrolStep } from './enrol.js';
import { InvalidLinkStep } from './invalid-link.js';
import { MagicLandingStep } from './magic-landing.js';
import { PasswordLinkStep } from './password-link.js';
import { SignInStep } from './sign-in.js';

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
 * The step router of the login card. The server renders it to markup for the
 * first paint and the client hydrates it from the same island, so one
 * component serves both; the markup of every step is static text from
 * `STRINGS` with no `style` attribute.
 */
export function LoginApp(props: LoginAppProps): ReactElement {
  const { step, next, linkKind = 'sign-in', behaviour } = props;
  return (
    <LoginBehaviourContext.Provider value={behaviour ?? null}>
      <LoginStepView step={step} next={next} linkKind={linkKind} />
    </LoginBehaviourContext.Provider>
  );
}

function LoginStepView(props: {
  readonly step: LoginStep;
  readonly next: string;
  readonly linkKind: LinkKind;
}): ReactElement {
  const { step, next, linkKind } = props;
  switch (step) {
    case 'sign-in':
      return <SignInStep next={next} />;
    case 'set-password':
    case 'reset-password':
      return <PasswordLinkStep variant={step} next={next} />;
    case 'magic-landing':
      return <MagicLandingStep next={next} />;
    case 'invalid-link':
      return <InvalidLinkStep linkKind={linkKind} next={next} />;
    case 'enrol':
      return <EnrolStep next={next} />;
  }
}
