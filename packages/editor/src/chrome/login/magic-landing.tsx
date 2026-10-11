import { useEffect, useRef, type ReactElement } from 'react';
import { SpinnerIcon } from '../icons.js';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour } from './behaviour.js';
import { LoginCard } from './card.js';

export type MagicLandingStepProps = {
  readonly next: string;
  /** No session came of the link: the invalid-link step. */
  readonly onInvalid?: () => void;
};

/**
 * The sign-in link landing: no fields, one status line with a spinner. The
 * link was spent on the server before this page was served, and left a
 * session cookie behind; the client reads that session and hands the user to
 * the same transition a password sign-in ends in. No session, or a session
 * that cannot be read, moves to the invalid-link step.
 */
export function MagicLandingStep(props: MagicLandingStepProps): ReactElement {
  const { next, onInvalid } = props;
  const behaviour = useLoginBehaviour();
  const startedRef = useRef(false);
  useEffect(() => {
    if (behaviour === null || startedRef.current) return;
    startedRef.current = true;
    void behaviour.auth.readSession().then((result) => {
      if (result.status === 'signed-in') {
        behaviour.signedIn(result.user);
      } else {
        onInvalid?.();
      }
    });
    // Runs once: `behaviour` is made once for the life of the root.
  }, [behaviour]);
  return (
    <LoginCard heading={STRINGS['login.magicLinkLanding.heading']} next={next}>
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
