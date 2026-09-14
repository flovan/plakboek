import {
  AuthEmailLayout,
  Button,
  LinkFallback,
  Paragraph,
  pluralise,
} from './layout.js';

export const RESET_PASSWORD_SUBJECT = 'Reset your password';

export type ResetPasswordEmailProps = {
  readonly name?: string;
  readonly url: string;
  readonly expiresInHours: string;
};

/** Sent when someone asks to reset the password of an existing account. */
export function ResetPasswordEmail({
  name,
  url,
  expiresInHours,
}: ResetPasswordEmailProps) {
  return (
    <AuthEmailLayout
      title={RESET_PASSWORD_SUBJECT}
      preview="Choose a new password for your account. The link expires soon."
    >
      <Paragraph>{name === undefined ? 'Hello,' : <>Hi {name},</>}</Paragraph>
      <Paragraph>
        We received a request to reset the password for your account. Use the
        button below to choose a new one.
      </Paragraph>
      <Button href={url}>Reset your password</Button>
      <Paragraph>
        This link works once and expires in {pluralise(expiresInHours, 'hour')}.
      </Paragraph>
      <LinkFallback href={url} />
      <Paragraph tone="muted">
        If you did not ask to reset your password, you can ignore this email.
        Your current password stays as it is.
      </Paragraph>
    </AuthEmailLayout>
  );
}
