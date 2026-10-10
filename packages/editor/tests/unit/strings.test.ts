import { describe, expect, it } from 'vitest';
import { STRINGS, formatString } from '../../src/chrome/strings.js';

/**
 * Every placeholder a string may carry, per key. A new `{name}` in a value
 * fails here until it is documented, so a translator and a component both
 * know the variables a key takes.
 */
const VARIABLES: Readonly<Record<string, readonly string[]>> = {
  'login.twoFactor.email.body': ['maskedEmail'],
  'login.magicLink.sent.body': ['email'],
  'login.forgot.sent.body': ['email'],
  'overlay.unavailable': ['type'],
};

const entries = Object.entries(STRINGS);

function placeholdersIn(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
}

describe('STRINGS', () => {
  it('is a frozen record', () => {
    expect(Object.isFrozen(STRINGS)).toBe(true);
  });

  it('uses stable dotted keys', () => {
    expect(entries.length).toBeGreaterThan(80);
    const bad = entries
      .map(([key]) => key)
      .filter((key) => !/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(key));
    expect(bad).toEqual([]);
  });

  it('holds only non-empty, trimmed string values', () => {
    const bad = entries
      .filter(
        ([, value]) =>
          typeof value !== 'string' ||
          value.length === 0 ||
          value !== value.trim(),
      )
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it('never uses an exclamation mark (plain, calm tone)', () => {
    const bad = entries
      .filter(([, value]) => value.includes('!'))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it('documents every placeholder, and every documented placeholder exists', () => {
    const found: Record<string, string[]> = {};
    for (const [key, value] of entries) {
      const names = placeholdersIn(value);
      if (names.length > 0) found[key] = names;
    }
    expect(found).toEqual(VARIABLES);
  });

  it('carries the sign-in and sidebar copy from the contract', () => {
    expect(STRINGS['login.signIn.heading']).toBe('Sign in');
    expect(STRINGS['login.signIn.submit']).toBe('Sign in');
    expect(STRINGS['login.signIn.magicLink']).toBe('Email me a sign-in link');
    expect(STRINGS['sidebar.fullWidth']).toBe('Full width');
    expect(STRINGS['sidebar.exit']).toBe('Exit edit mode');
    expect(STRINGS['sidebar.logOut']).toBe('Log out');
    expect(STRINGS['sidebar.skipLink']).toBe('Skip to page');
    expect(STRINGS['product.name']).toBe('Plakboek');
    expect(STRINGS['login.backToSite']).toBe('Back to site');
    expect(STRINGS['transition.opening']).toBe('Opening the page');
  });

  it('carries every error and validation row from the contract', () => {
    expect(STRINGS['error.credentials']).toBe(
      'Email or password is incorrect. Check them and try again.',
    );
    expect(STRINGS['error.rateLimited']).toBe(
      'Too many attempts. Wait a few minutes, then try again.',
    );
    expect(STRINGS['error.code']).toBe(
      'That code is not valid or has expired. Check it and try again.',
    );
    expect(STRINGS['error.network']).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
    expect(STRINGS['error.server']).toBe(
      'Something went wrong on our side. Try again in a moment.',
    );
    expect(STRINGS['validation.email.empty']).toBe('Enter your email address.');
    expect(STRINGS['validation.email.malformed']).toBe(
      'Enter an address like name@example.com.',
    );
    expect(STRINGS['validation.password.empty']).toBe('Enter your password.');
    expect(STRINGS['validation.code.invalid']).toBe('Enter the 6-digit code.');
    expect(STRINGS['validation.newPassword.tooShort']).toBe(
      'Use at least 12 characters.',
    );
    expect(STRINGS['validation.confirm.mismatch']).toBe(
      'The two passwords do not match.',
    );
  });

  it('carries the loading words, panels and landmarks', () => {
    expect(STRINGS['loading.signingIn']).toBe('Signing in');
    expect(STRINGS['loading.verifying']).toBe('Verifying');
    expect(STRINGS['loading.sending']).toBe('Sending');
    expect(STRINGS['loading.saving']).toBe('Saving');
    expect(STRINGS['loading.checking']).toBe('Checking');
    expect(STRINGS['frame.narrow.heading']).toBe(
      'Editing needs a wider window',
    );
    expect(STRINGS['frame.error.heading']).toBe(
      'This page could not be shown in edit mode',
    );
    expect(STRINGS['frame.error.reload']).toBe('Reload page');
    expect(STRINGS['sidebar.readOnly']).toBe(
      'Your role can view this site but not edit pages.',
    );
    expect(STRINGS['landmark.sidebar']).toBe('Editor');
    expect(STRINGS['landmark.frame']).toBe('Page being edited');
  });

  it('carries the two-step enrolment copy', () => {
    expect(STRINGS['enrol.confirm.heading']).toBe('Set up two-step sign-in');
    expect(STRINGS['enrol.confirm.submit']).toBe('Continue');
    expect(STRINGS['enrol.key.heading']).toBe(
      'Add this site to your authenticator app',
    );
    expect(STRINGS['enrol.key.label']).toBe('Setup key');
    expect(STRINGS['enrol.key.copy']).toBe('Copy setup key');
    expect(STRINGS['enrol.key.copied']).toBe('Setup key copied.');
    expect(STRINGS['enrol.key.link']).toBe('Open in authenticator app');
    expect(STRINGS['enrol.key.submit']).toBe('Verify');
    expect(STRINGS['enrol.backup.heading']).toBe('Save your backup codes');
    expect(STRINGS['enrol.backup.copy']).toBe('Copy codes');
    expect(STRINGS['enrol.backup.copied']).toBe('Backup codes copied.');
    expect(STRINGS['enrol.backup.submit']).toBe('I have saved my codes');
    expect(STRINGS['error.passwordIncorrect']).toBe(
      'That password is not correct. Try again.',
    );
  });

  it('warns that sign-in links do not work for authenticator-app accounts', () => {
    expect(STRINGS['login.magicLink.twoFactorNote']).toBe(
      'Accounts that sign in with a code from an authenticator app cannot use sign-in links.',
    );
  });
});

describe('formatString', () => {
  it('interpolates a placeholder once and escapes nothing', () => {
    expect(
      formatString('login.magicLink.sent.body', { email: 'a@b.test' }),
    ).toBe(
      'If an account exists for a@b.test, a sign-in link is on its way. The link works once.',
    );
    expect(
      formatString('login.magicLink.sent.body', { email: '<b>&"x"</b>' }),
    ).toContain('<b>&"x"</b>');
  });

  it('does not interpolate placeholders that appear inside a value', () => {
    expect(
      formatString('login.magicLink.sent.body', { email: '{email}' }),
    ).toContain('exists for {email},');
  });

  it('requires the variables a key names, checked by the compiler', () => {
    // @ts-expect-error the key names {email}, so the variables are required
    const missing = formatString('login.magicLink.sent.body');
    expect(missing).toContain('{email}');
    // @ts-expect-error a variable the key does not name is rejected
    formatString('sidebar.exit', { email: 'a@b.test' });
  });

  it('returns a string without placeholders unchanged', () => {
    expect(formatString('sidebar.exit')).toBe('Exit edit mode');
  });

  it('formats the unavailable chip suffix with the stored type key', () => {
    expect(formatString('overlay.unavailable', { type: 'hero' })).toBe(
      'hero (unavailable)',
    );
  });
});
