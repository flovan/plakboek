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
  'login.password.new.hint': ['min'],
  'validation.newPassword.tooShort': ['min'],
  'overlay.unavailable': ['type'],
  'lock.expiring': ['time'],
  'announce.selected': ['label', 'position', 'total', 'parent'],
  'announce.selectedSection': ['label', 'position', 'total'],
  'announce.added': ['label'],
  'announce.moved': ['label', 'position', 'total', 'parent'],
  'announce.restored': ['label'],
  'announce.undone': ['action'],
  'announce.redone': ['action'],
  'announce.drag.pickedUp': ['label'],
  'announce.drag.position': ['position', 'total', 'parent'],
  'announce.drag.dropped': ['label', 'position', 'total', 'parent'],
  'action.added': ['label'],
  'action.moved': ['label'],
  'action.deleted': ['label'],
  'action.duplicated': ['label'],
  'action.changed': ['property', 'label'],
  'label.column': ['n'],
  'toolbar.label': ['label'],
  'toolbar.drag.label': ['label'],
  'toolbar.moveLeft.label': ['label'],
  'toolbar.moveRight.label': ['label'],
  'toolbar.moveUp.label': ['label'],
  'toolbar.moveDown.label': ['label'],
  'toolbar.addAfter.label': ['label'],
  'toolbar.duplicate.label': ['label'],
  'toolbar.properties.label': ['label'],
  'toolbar.delete.label': ['label'],
  'insert.blockAfter': ['label'],
  'picker.noMatch': ['query'],
  'rail.withNotice': ['label'],
  'delete.heading': ['kind'],
  'delete.body.other': ['count'],
  'delete.confirm': ['kind'],
  'toast.deleted': ['label'],
  'panel.column.count.other': ['count'],
  'panel.column.moveEarlier': ['label'],
  'panel.column.moveLater': ['label'],
  'panel.column.remove': ['label'],
  'panel.allowedHint': ['values'],
  'notice.locked.heading': ['name'],
  'notice.locked.body': ['time'],
  'notice.lapsed': ['name'],
  'notice.takenOver.heading': ['name'],
  'takeover.body': ['name'],
};

/**
 * The only values allowed to start or end with a space: each is joined onto
 * other text by a component, so the space is part of the copy.
 */
const SPACED = ['announce.needsInput', 'panel.preset.separator'];

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
        ([key, value]) =>
          typeof value !== 'string' ||
          value.length === 0 ||
          (value !== value.trim() && !SPACED.includes(key)),
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
    expect(formatString('validation.newPassword.tooShort', { min: '12' })).toBe(
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

  it('carries the Phase 8 edit tools, save states and lock copy', () => {
    expect(STRINGS['tools.mode.label']).toBe('Mode');
    expect(STRINGS['tools.mode.edit']).toBe('Edit');
    expect(STRINGS['tools.mode.interact']).toBe('Interact');
    expect(STRINGS['tools.mode.railTooltip']).toBe('Interact mode (I)');
    expect(STRINGS['save.saved']).toBe('All changes saved');
    expect(STRINGS['save.saving']).toBe('Saving');
    expect(STRINGS['save.failed']).toBe('Could not save your changes');
    expect(STRINGS['save.paused']).toBe('Saving is paused');
    expect(STRINGS['save.retry']).toBe('Retry');
    expect(STRINGS['lock.renewing']).toBe('Renewing');
    expect(STRINGS['takeover.inFlight']).toBe('Taking over');
    expect(STRINGS['notice.retryFailed']).toBe("That didn't work. Try again.");
  });

  it('words the lock banner as the holder last activity, never as when the lock began', () => {
    expect(formatString('notice.locked.body', { time: '5 minutes ago' })).toBe(
      'Last active 5 minutes ago. You can look around. This page opens for editing automatically when they are done.',
    );
    const bad = entries
      .filter(([, value]) => value.includes('Since {time}'))
      .map(([key]) => key);
    expect(bad).toEqual([]);
    expect(formatString('notice.locked.heading', { name: 'Sam' })).toBe(
      'Sam is editing this page',
    );
  });

  it('carries the delete dialog pair and its plural keys', () => {
    expect(formatString('delete.heading', { kind: 'section' })).toBe(
      'Delete this section?',
    );
    expect(formatString('delete.confirm', { kind: 'column' })).toBe(
      'Delete column',
    );
    expect(STRINGS['delete.body.one']).toBe('This removes 1 block inside it.');
    expect(formatString('delete.body.other', { count: '3' })).toBe(
      'This removes 3 blocks inside it.',
    );
    expect(STRINGS['delete.note']).toBe('You can undo this right after.');
    expect(STRINGS['panel.column.count.one']).toBe('1 block');
    expect(formatString('panel.column.count.other', { count: '5' })).toBe(
      '5 blocks',
    );
  });

  it('carries the toolbar disabled reasons, including the missing delete permission', () => {
    expect(STRINGS['toolbar.reason.lastColumn']).toBe(
      'A section needs at least one column.',
    );
    expect(STRINGS['toolbar.reason.noDeletePermission']).toBe(
      "Your role can't delete content on this page.",
    );
    expect(formatString('toolbar.moveLeft.label', { label: 'Text' })).toBe(
      'Move Text left',
    );
  });

  it('pairs every .one key with an .other key', () => {
    const keys = entries.map(([key]) => key);
    const ones = keys.filter((key) => key.endsWith('.one'));
    expect(ones.length).toBeGreaterThan(0);
    for (const one of ones) {
      expect(keys).toContain(one.replace(/\.one$/, '.other'));
    }
  });

  it('keeps the interpolated name or time as plain text, never markup', () => {
    expect(
      formatString('notice.lapsed', { name: '<img src=x onerror=1>' }),
    ).toBe(
      '<img src=x onerror=1> stopped editing. You can edit this page now.',
    );
    const markup = entries
      .filter(([, value]) => /<[a-z/]/i.test(value))
      .map(([key]) => key);
    expect(markup).toEqual([]);
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
    // @ts-expect-error the lock banner names {time}, so it is required
    const noTime = formatString('notice.locked.body');
    expect(noTime).toContain('{time}');
    // @ts-expect-error the delete heading names {kind}, not {label}
    formatString('delete.heading', { label: 'Text' });
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
