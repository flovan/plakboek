import type { ReactElement } from 'react';
import type { LinkKind } from '../island.js';
import { STRINGS } from '../strings.js';
import { LoginCard, PRIMARY_BUTTON } from './card.js';

export type InvalidLinkStepProps = {
  readonly linkKind: LinkKind;
  readonly next: string;
  /** The one button: a new reset link, a new sign-in link, or back to
   * sign-in, according to the kind. */
  readonly onAction?: () => void;
};

/**
 * One heading and one sentence for an expired, used or malformed link, so
 * nothing reveals which it was. Only the button depends on the kind of link.
 * The one exception is a sign-in link the service refused to turn into a
 * session (`two-factor`): an account with two-step sign-in cannot use one, and
 * the person is told to sign in with their password and a code, instead of
 * being sent to ask for a link that would never arrive.
 */
export function InvalidLinkStep(props: InvalidLinkStepProps): ReactElement {
  const { linkKind, next, onAction } = props;
  const twoFactor = linkKind === 'two-factor';
  const body = twoFactor
    ? STRINGS['login.invalidLink.twoFactor.body']
    : linkKind === 'invite'
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
      heading={
        twoFactor
          ? STRINGS['login.invalidLink.twoFactor.heading']
          : STRINGS['login.invalidLink.heading']
      }
      body={body}
      next={next}
    >
      <button type="button" onClick={onAction} className={PRIMARY_BUTTON}>
        {action}
      </button>
    </LoginCard>
  );
}
