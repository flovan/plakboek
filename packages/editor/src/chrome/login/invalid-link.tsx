import type { ReactElement } from 'react';
import type { LinkKind } from '../island.js';
import { STRINGS } from '../strings.js';
import { LoginCard, PRIMARY_BUTTON } from './card.js';

export type InvalidLinkStepProps = {
  readonly linkKind: LinkKind;
  readonly next: string;
};

/**
 * One heading and one sentence for an expired, used or malformed link, so
 * nothing reveals which it was. Only the button depends on the kind of link.
 */
export function InvalidLinkStep(props: InvalidLinkStepProps): ReactElement {
  const { linkKind, next } = props;
  const body =
    linkKind === 'invite'
      ? STRINGS['login.invalidLink.invite.body']
      : STRINGS['login.invalidLink.body'];
  const action =
    linkKind === 'reset'
      ? STRINGS['login.invalidLink.reset.submit']
      : linkKind === 'sign-in'
        ? STRINGS['login.invalidLink.signIn.submit']
        : STRINGS['login.invalidLink.invite.submit'];
  return (
    <LoginCard
      heading={STRINGS['login.invalidLink.heading']}
      body={body}
      next={next}
    >
      <button
        type="button"
        data-action={`invalid-${linkKind}`}
        className={PRIMARY_BUTTON}
      >
        {action}
      </button>
    </LoginCard>
  );
}
