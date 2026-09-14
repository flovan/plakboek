/**
 * The credential-setting path the invite flow and the self-service reset
 * flow share (AUTH-05). Skeleton: behaviour arrives with the GREEN commit.
 */
import type { RenderAuthEmail } from './config.js';
import type { MailSender } from './email/types.js';
import type { TokenDatabase } from './tokens.js';

export type PasswordLinkPurpose = 'set-password' | 'reset-password';

export type PasswordLinkRequestOutcome = { readonly delivered: true };

export type PasswordLinkProbe = {
  onTokenGenerated?(): void;
  onVerificationQuery?(): void;
};

export type RequestPasswordLinkDeps = {
  readonly db: TokenDatabase;
  readonly mail: MailSender;
  readonly renderEmail?: RenderAuthEmail;
  readonly baseURL: string;
  readonly onDeliveryError?: (error: unknown) => void;
  readonly probe?: PasswordLinkProbe;
};

export type RequestPasswordLinkInput = {
  readonly email: string;
  readonly purpose: PasswordLinkPurpose;
};

export const PASSWORD_LINK_PATHS: Readonly<
  Record<PasswordLinkPurpose, string>
> = Object.freeze({
  'set-password': '/cms/set-password',
  'reset-password': '/cms/reset-password',
});

export function requestPasswordLink(
  _deps: RequestPasswordLinkDeps,
  _input: RequestPasswordLinkInput,
): Promise<PasswordLinkRequestOutcome> {
  return Promise.resolve({ delivered: true });
}
