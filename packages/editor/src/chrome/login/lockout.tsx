import type { ReactElement } from 'react';
import { STRINGS } from '../strings.js';
import { LoginCard, PRIMARY_BUTTON } from './card.js';

export type LockoutStepProps = {
  readonly next: string;
  /** Returns to a fresh sign-in step. */
  readonly onBack: () => void;
};

/**
 * Too many wrong codes (or a sign-in whose code window is spent). It asks for
 * nothing; the one way on is to sign in again from the start.
 */
export function LockoutStep(props: LockoutStepProps): ReactElement {
  return (
    <LoginCard
      heading={STRINGS['login.lockout.heading']}
      body={STRINGS['login.lockout.body']}
      next={props.next}
    >
      <button type="button" onClick={props.onBack} className={PRIMARY_BUTTON}>
        {STRINGS['login.lockout.submit']}
      </button>
    </LoginCard>
  );
}
