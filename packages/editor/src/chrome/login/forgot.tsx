import type { ReactElement } from 'react';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour } from './behaviour.js';
import { LoginCard, TEXT_LINK } from './card.js';
import { RequestLinkForm } from './request-link.js';

export type ForgotStepProps = {
  readonly next: string;
  /** The request went through; called with the address that was typed. */
  readonly onSent: (email: string) => void;
  readonly onBack: () => void;
};

/**
 * The forgot-password step: an email address and one button. The service
 * answers the same whether or not the address has an account, so the card
 * goes on to the shared "Check your email" state either way.
 */
export function ForgotStep(props: ForgotStepProps): ReactElement {
  const { next, onSent, onBack } = props;
  const behaviour = useLoginBehaviour();
  return (
    <LoginCard
      heading={STRINGS['login.forgot.heading']}
      body={STRINGS['login.forgot.body']}
      next={next}
      secondary={
        <button type="button" onClick={onBack} className={TEXT_LINK}>
          {STRINGS['login.forgot.back']}
        </button>
      }
    >
      <RequestLinkForm
        send={async (email) =>
          behaviour === null
            ? { status: 'failed', failure: 'server' }
            : await behaviour.auth.requestResetLink(email, next)
        }
        submitLabel={STRINGS['login.forgot.submit']}
        onSent={onSent}
      />
    </LoginCard>
  );
}
