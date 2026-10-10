import type { ReactElement } from 'react';
import type { LinkKind, LoginStep } from '../island.js';
import { SignInStep } from './sign-in.js';

export type LoginAppProps = {
  readonly step: LoginStep;
  /** The same-origin page behind the card and the "Back to site" target. */
  readonly next: string;
  /** Which kind of link an `invalid-link` step stands in for. */
  readonly linkKind?: LinkKind;
};

/**
 * The step router of the login card. The server renders it to markup for the
 * first paint and the client hydrates it from the same island, so one
 * component serves both; the markup of every step is static text from
 * `STRINGS` with no `style` attribute.
 */
export function LoginApp(props: LoginAppProps): ReactElement {
  return <SignInStep next={props.next} />;
}
