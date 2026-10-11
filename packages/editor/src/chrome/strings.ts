/**
 * Every string edit mode shows, in one module with stable dotted keys, so a
 * later translation catalogue changes no component: components ask for a key,
 * never for English text. The values are the English source copy.
 *
 * A `{name}` in a value is a variable. `formatString` requires exactly the
 * variables a key's value names, checked by the compiler. Values are plain
 * text; React escapes them at render, so nothing here is HTML.
 *
 * Tone: plain, second person, no exclamation marks, and nothing that reveals
 * whether an account exists.
 */
export const STRINGS = Object.freeze({
  // Product
  'product.name': 'Plakboek',

  // Sign-in
  'login.signIn.heading': 'Sign in',
  'login.signIn.email.label': 'Email address',
  'login.signIn.password.label': 'Password',
  'login.signIn.forgot': 'Forgot your password?',
  'login.signIn.submit': 'Sign in',
  'login.signIn.magicLink': 'Email me a sign-in link',
  'login.signIn.status.passwordSet':
    'Your password is set. Sign in to continue.',
  'login.signIn.status.passwordReset':
    'Your password has been reset. Sign in to continue.',
  'login.backToSite': 'Back to site',

  // Two-factor
  'login.twoFactor.code.label': 'Authentication code',
  'login.twoFactor.submit': 'Verify',
  'login.twoFactor.totp.heading': 'Enter your code',
  'login.twoFactor.totp.body':
    'Enter the 6-digit code from your authenticator app.',
  'login.twoFactor.totp.useEmail': 'Email me a code instead',
  'login.twoFactor.totp.useBackup': 'Use a backup code',
  'login.twoFactor.backup.heading': 'Use a backup code',
  'login.twoFactor.backup.body':
    'Enter one of the backup codes you saved when you set up two-step sign-in. Each code works once.',
  'login.twoFactor.backup.label': 'Backup code',
  'login.twoFactor.backup.useTotp': 'Use your authenticator app instead',
  'login.twoFactor.email.heading': 'Check your email',
  'login.twoFactor.email.body': 'We emailed a 6-digit code to {maskedEmail}.',
  'login.twoFactor.email.resend': 'Resend code',
  'login.twoFactor.email.useTotp': 'Use your authenticator app instead',
  'login.lockout.heading': 'Too many incorrect codes',
  'login.lockout.body': 'Sign in again to continue.',
  'login.lockout.submit': 'Back to sign in',

  // Sign-in link request and sent
  'login.magicLink.heading': 'Email me a sign-in link',
  'login.magicLink.body':
    "Enter your email address and we'll send a link that signs you in.",
  'login.magicLink.twoFactorNote':
    'Accounts that sign in with a code from an authenticator app cannot use sign-in links.',
  'login.magicLink.submit': 'Send sign-in link',
  'login.magicLink.back': 'Back to sign in',
  'login.magicLink.sent.heading': 'Check your email',
  'login.magicLink.sent.body':
    'If an account exists for {email}, a sign-in link is on its way. The link works once.',
  'login.magicLink.sent.back': 'Back to sign in',

  // Forgotten password
  'login.forgot.heading': 'Reset your password',
  'login.forgot.body':
    "Enter your email address and we'll send a link to choose a new password.",
  'login.forgot.submit': 'Send reset link',
  'login.forgot.back': 'Back to sign in',
  'login.forgot.sent.heading': 'Check your email',
  'login.forgot.sent.body':
    'If an account exists for {email}, a reset link is on its way. The link works once.',
  'login.forgot.sent.back': 'Back to sign in',

  // Choosing a password (invitation and reset landings)
  'login.password.new.label': 'New password',
  'login.password.new.hint':
    'At least {min} characters. A passphrase works well.',
  'login.password.confirm.label': 'Confirm new password',
  'login.setPassword.heading': 'Choose a password',
  'login.setPassword.body':
    "You've been invited to edit this site. Choose a password to finish setting up your account.",
  'login.setPassword.submit': 'Set password',
  'login.resetPassword.heading': 'Choose a new password',
  'login.resetPassword.body': 'Choose a new password for your account.',
  'login.resetPassword.submit': 'Reset password',

  // Sign-in link landing and invalid links
  'login.magicLinkLanding.heading': 'Signing you in',
  'login.magicLinkLanding.status': 'Signing you in.',
  'login.invalidLink.heading': 'This link is no longer valid',
  'login.invalidLink.body':
    'Links work once and expire after a while. Request a new one to continue.',
  'login.invalidLink.reset.submit': 'Request a new reset link',
  'login.invalidLink.signIn.submit': 'Request a new sign-in link',
  'login.invalidLink.invite.body':
    'Ask the person who invited you to send a new invitation.',
  'login.invalidLink.invite.submit': 'Back to sign in',
  'login.invalidLink.twoFactor.heading': 'This link could not sign you in',
  'login.invalidLink.twoFactor.body':
    'If your account uses two-step sign-in, sign-in links are not available. Sign in with your password and a code instead.',

  // In-flight words for a submit button
  'loading.signingIn': 'Signing in',
  'loading.verifying': 'Verifying',
  'loading.sending': 'Sending',
  'loading.saving': 'Saving',
  'loading.checking': 'Checking',

  // Inline field validation
  'validation.email.empty': 'Enter your email address.',
  'validation.email.malformed': 'Enter an address like name@example.com.',
  'validation.password.empty': 'Enter your password.',
  'validation.code.invalid': 'Enter the 6-digit code.',
  'validation.backupCode.empty': 'Enter a backup code.',
  'validation.newPassword.tooShort': 'Use at least {min} characters.',
  'validation.confirm.mismatch': 'The two passwords do not match.',

  // Error box
  'error.credentials':
    'Email or password is incorrect. Check them and try again.',
  'error.rateLimited': 'Too many attempts. Wait a few minutes, then try again.',
  'error.code':
    'That code is not valid or has expired. Check it and try again.',
  'error.backupCode':
    'That backup code is not valid or has already been used. Check it and try again.',
  'error.network':
    'Could not reach the server. Check your connection and try again.',
  'error.server': 'Something went wrong on our side. Try again in a moment.',
  'error.passwordIncorrect': 'That password is not correct. Try again.',

  // Two-step sign-in set-up: confirm the password first
  'enrol.confirm.heading': 'Set up two-step sign-in',
  'enrol.confirm.body':
    'Your role signs in with a password and a code from an authenticator app. Confirm your password to set this up.',
  'enrol.confirm.submit': 'Continue',
  // ... then add the key to the authenticator app and prove it with a code
  'enrol.key.heading': 'Add this site to your authenticator app',
  'enrol.key.body':
    'In your authenticator app, add an account and enter this setup key. On a device that has the app, you can open the link instead.',
  'enrol.key.label': 'Setup key',
  'enrol.key.copy': 'Copy setup key',
  'enrol.key.copied': 'Setup key copied.',
  'enrol.key.link': 'Open in authenticator app',
  'enrol.key.codeHint': 'Enter the 6-digit code the app shows for this site.',
  'enrol.key.submit': 'Verify',
  // ... then save the backup codes
  'enrol.backup.heading': 'Save your backup codes',
  'enrol.backup.body':
    'Each code signs you in once if you lose your authenticator app. They are shown only now, so store them somewhere safe.',
  'enrol.backup.copy': 'Copy codes',
  'enrol.backup.copied': 'Backup codes copied.',
  'enrol.backup.submit': 'I have saved my codes',

  // Sidebar and rail
  'sidebar.fullWidth': 'Full width',
  'sidebar.exit': 'Exit edit mode',
  'sidebar.logOut': 'Log out',
  'sidebar.skipLink': 'Skip to page',
  'sidebar.readOnly': 'Your role can view this site but not edit pages.',

  // Landmarks
  'landmark.sidebar': 'Editor',
  'landmark.frame': 'Page being edited',

  // Frame states
  'frame.narrow.heading': 'Editing needs a wider window',
  'frame.narrow.body':
    'Make this window at least 1024 pixels wide to edit, or exit edit mode.',
  'frame.error.heading': 'This page could not be shown in edit mode',
  'frame.error.body':
    'Reload to try again. If it keeps happening, exit edit mode and check that the page loads for visitors.',
  'frame.error.reload': 'Reload page',

  // Overlay label for a block whose type is not available
  'overlay.unavailable': '{type} (unavailable)',

  // Login-to-edit transition
  'transition.opening': 'Opening the page',
});

/** A key of `STRINGS`. */
export type StringKey = keyof typeof STRINGS;

/** The names of the `{name}` placeholders in a string literal type. */
type Placeholders<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | Placeholders<Rest>
    : never;

type VariablesOf<K extends StringKey> = Placeholders<(typeof STRINGS)[K]>;

type FormatArguments<K extends StringKey> = [VariablesOf<K>] extends [never]
  ? []
  : [variables: Readonly<Record<VariablesOf<K>, string>>];

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The string for a key with its `{name}` placeholders replaced. Replacement
 * is one pass over the template, so a variable's value is never interpolated
 * again, and nothing is escaped: React escapes text when it renders.
 */
export function formatString<K extends StringKey>(
  key: K,
  ...args: FormatArguments<K>
): string {
  const variables: Readonly<Record<string, string>> = args[0] ?? {};
  return STRINGS[key].replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return value ?? placeholder;
  });
}
