import {
  AuthEmailLayout,
  Button,
  LinkFallback,
  Paragraph,
  pluralise,
} from './layout.js';

export const SET_PASSWORD_SUBJECT =
  'Set your password to activate your account';

export type SetPasswordEmailProps = {
  readonly name?: string;
  readonly url: string;
  readonly expiresInHours: string;
};

/** Sent to a newly invited user, and again on resend; the latest link is
 * the only one that works. */
export function SetPasswordEmail({
  name,
  url,
  expiresInHours,
}: SetPasswordEmailProps) {
  return (
    <AuthEmailLayout
      title={SET_PASSWORD_SUBJECT}
      preview="You have been invited. Choose a password to start using your account."
    >
      <Paragraph>{name === undefined ? 'Hello,' : <>Hi {name},</>}</Paragraph>
      <Paragraph>
        An account has been created for you. Choose a password to activate it
        and sign in for the first time.
      </Paragraph>
      <Button href={url}>Set your password</Button>
      <Paragraph>
        This link works once and expires in {pluralise(expiresInHours, 'hour')}.
        If it has expired, ask the person who invited you to send a new one.
      </Paragraph>
      <LinkFallback href={url} />
      <Paragraph tone="muted">
        If you were not expecting this invitation, you can ignore this email.
      </Paragraph>
    </AuthEmailLayout>
  );
}
