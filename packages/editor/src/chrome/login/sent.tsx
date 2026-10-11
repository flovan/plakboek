import type { ReactElement } from 'react';
import { formatString, STRINGS } from '../strings.js';
import { LoginCard, TEXT_LINK } from './card.js';

export type SentStateProps = {
  /** Which request this answers, so the body names the right link. */
  readonly kind: 'reset' | 'sign-in';
  /** The address that was typed, repeated back as it was sent. */
  readonly email: string;
  readonly next: string;
  readonly onBack: () => void;
};

/**
 * The state both request steps end in: "Check your email". Its words are the
 * same for every address (they say "if an account exists"), so nothing on
 * screen, in its timing or in its focus tells a registered address from any
 * other. The address is interpolated as text and breaks anywhere, so a very
 * long one cannot widen the card.
 */
export function SentState(props: SentStateProps): ReactElement {
  const { kind, email, next, onBack } = props;
  const reset = kind === 'reset';
  return (
    <LoginCard
      heading={
        reset
          ? STRINGS['login.forgot.sent.heading']
          : STRINGS['login.magicLink.sent.heading']
      }
      body={
        reset
          ? formatString('login.forgot.sent.body', { email })
          : formatString('login.magicLink.sent.body', { email })
      }
      next={next}
      secondary={
        <button type="button" onClick={onBack} className={TEXT_LINK}>
          {reset
            ? STRINGS['login.forgot.sent.back']
            : STRINGS['login.magicLink.sent.back']}
        </button>
      }
    />
  );
}
