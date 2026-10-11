import type { ReactElement } from 'react';
import { STRINGS } from '../strings.js';
import { useLoginBehaviour } from './behaviour.js';
import { LoginCard, TEXT_LINK } from './card.js';
import { RequestLinkForm } from './request-link.js';

export type MagicRequestStepProps = {
  readonly next: string;
  /** The request went through; called with the address that was typed. */
  readonly onSent: (email: string) => void;
  readonly onBack: () => void;
};

/**
 * The sign-in-link request step. It says in general terms that accounts
 * using an authenticator app cannot use a sign-in link; it never says
 * whether a given address is one of them, because the service answers the
 * same for those as for every other address.
 */
export function MagicRequestStep(props: MagicRequestStepProps): ReactElement {
  const { next, onSent, onBack } = props;
  const behaviour = useLoginBehaviour();
  return (
    <LoginCard
      heading={STRINGS['login.magicLink.heading']}
      body={`${STRINGS['login.magicLink.body']} ${STRINGS['login.magicLink.twoFactorNote']}`}
      next={next}
      secondary={
        <button type="button" onClick={onBack} className={TEXT_LINK}>
          {STRINGS['login.magicLink.back']}
        </button>
      }
    >
      <RequestLinkForm
        send={async (email) =>
          behaviour === null
            ? { status: 'failed', failure: 'server' }
            : await behaviour.auth.requestSignInLink(email, next)
        }
        submitLabel={STRINGS['login.magicLink.submit']}
        onSent={onSent}
      />
    </LoginCard>
  );
}
