import type { ReactElement } from 'react';
import { SpinnerIcon } from '../icons.js';
import { STRINGS } from '../strings.js';
import { LoginCard } from './card.js';

export type MagicLandingStepProps = {
  readonly next: string;
};

/**
 * The sign-in link landing: no fields, one status line with a spinner. The
 * client completes the sign-in; a failure moves to the invalid-link step.
 */
export function MagicLandingStep(props: MagicLandingStepProps): ReactElement {
  return (
    <LoginCard
      heading={STRINGS['login.magicLinkLanding.heading']}
      next={props.next}
    >
      <p
        role="status"
        className="m-0 flex items-center gap-2 text-body text-text-muted"
      >
        <SpinnerIcon size={20} className="motion-safe:animate-spin" />
        {STRINGS['login.magicLinkLanding.status']}
      </p>
    </LoginCard>
  );
}
