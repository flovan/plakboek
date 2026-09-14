import { AuthEmailLayout, Paragraph, pluralise } from './layout.js';

export const TWO_FACTOR_CODE_SUBJECT = 'Your verification code';

export type TwoFactorCodeEmailProps = {
  readonly code: string;
  readonly expiresInMinutes: string;
};

/** An emailed second factor. It deliberately carries no link: the code is
 * useless without the password step already done in the browser, so a
 * captured or forwarded message cannot complete a sign-in on its own. */
export function TwoFactorCodeEmail({
  code,
  expiresInMinutes,
}: TwoFactorCodeEmailProps) {
  return (
    <AuthEmailLayout
      title={TWO_FACTOR_CODE_SUBJECT}
      preview="Use the code inside to finish signing in."
    >
      <Paragraph>Hello,</Paragraph>
      <Paragraph>Enter this code to finish signing in:</Paragraph>
      <Paragraph
        style={{
          margin: '8px 0 24px',
          fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
          fontSize: 28,
          fontWeight: 700,
          lineHeight: '36px',
          letterSpacing: 6,
        }}
      >
        {code}
      </Paragraph>
      <Paragraph>
        The code expires in {pluralise(expiresInMinutes, 'minute')}. Never share
        it with anyone, including someone who says they are support.
      </Paragraph>
      <Paragraph tone="muted">
        If you did not try to sign in, someone may know your password. Change it
        as soon as you can.
      </Paragraph>
    </AuthEmailLayout>
  );
}
