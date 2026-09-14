import {
  AuthEmailLayout,
  Button,
  LinkFallback,
  Paragraph,
  pluralise,
} from './layout.js';

export const MAGIC_LINK_SUBJECT = 'Your sign-in link';

export type MagicLinkEmailProps = {
  readonly url: string;
  readonly expiresInMinutes: string;
};

/** A one-time sign-in link. It is a live login, so the copy is explicit
 * about its short lifetime. */
export function MagicLinkEmail({ url, expiresInMinutes }: MagicLinkEmailProps) {
  return (
    <AuthEmailLayout
      title={MAGIC_LINK_SUBJECT}
      preview="Use this link to sign in. It works once and expires soon."
    >
      <Paragraph>Hello,</Paragraph>
      <Paragraph>Use the button below to sign in to your account.</Paragraph>
      <Button href={url}>Sign in</Button>
      <Paragraph>
        This link works once and expires in{' '}
        {pluralise(expiresInMinutes, 'minute')}. Do not forward this email:
        anyone with the link can sign in as you until it expires.
      </Paragraph>
      <LinkFallback href={url} />
      <Paragraph tone="muted">
        If you did not try to sign in, you can ignore this email.
      </Paragraph>
    </AuthEmailLayout>
  );
}
