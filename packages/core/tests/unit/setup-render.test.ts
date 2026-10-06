import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  renderSetupComplete,
  renderSetupForm,
  renderSetupUnavailable,
  type SetupIssue,
} from '../../src/setup/render.js';
import { SETUP_CSP, SETUP_STYLES } from '../../src/setup/styles.js';

/**
 * The opening tag of the input with this `name`. Attribute names are
 * lowercased because React's server renderer emits some in camelCase
 * (`autoComplete`, `maxLength`), which HTML treats as the same attribute.
 */
function inputTag(html: string, name: string): string {
  const match = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no input named ${name}`);
  return match[0].replace(
    /(\s)([A-Za-z-]+)=/g,
    (_all, space: string, attribute: string) =>
      `${space}${attribute.toLowerCase()}=`,
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const allIssues: readonly SetupIssue[] = [
  { field: 'name', message: 'Name: enter your name.' },
  {
    field: 'email',
    message: 'Email address: enter an address like name@example.com.',
  },
  { field: 'password', message: 'Password: use at least 12 characters.' },
  {
    field: 'passwordConfirm',
    message: 'Confirm password: the two passwords do not match.',
  },
];

function everyScreen(): readonly string[] {
  return [
    renderSetupForm({}),
    renderSetupForm({
      values: { name: 'Ada', email: 'ada@example.com' },
      issues: allIssues,
    }),
    renderSetupUnavailable('race'),
    renderSetupUnavailable('database'),
    renderSetupComplete({
      email: 'ada@example.com',
      token: 'tok.en',
      homePublished: true,
    }),
    renderSetupComplete({
      email: 'ada@example.com',
      token: 'tok.en',
      homePublished: true,
      result: { kind: 'failed', detail: 'connect ECONNREFUSED 127.0.0.1:1' },
    }),
  ];
}

describe('renderSetupForm', () => {
  const html = renderSetupForm({});

  it('is a complete English document with the S1 head', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Set up Plakboek</title>');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain('<main');
    expect(html).toContain('<h1>Set up Plakboek</h1>');
  });

  it('renders the four fields with the S1.1 attributes', () => {
    const name = inputTag(html, 'name');
    expect(name).toContain('type="text"');
    expect(name).toContain('autocomplete="name"');
    expect(name).toContain('required=""');
    expect(name).toContain('maxlength="200"');
    expect(name).not.toContain('autofocus');

    const email = inputTag(html, 'email');
    expect(email).toContain('type="email"');
    expect(email).toContain('autocomplete="email"');
    expect(email).toContain('required=""');
    expect(email).toContain('maxlength="320"');
    expect(email).toContain('autofocus=""');

    const password = inputTag(html, 'password');
    expect(password).toContain('type="password"');
    expect(password).toContain('autocomplete="new-password"');
    expect(password).toContain('required=""');
    expect(password).toContain('minlength="12"');
    expect(password).not.toContain('autofocus');

    const confirm = inputTag(html, 'passwordConfirm');
    expect(confirm).toContain('type="password"');
    expect(confirm).toContain('autocomplete="new-password"');
    expect(confirm).toContain('required=""');
    expect(confirm).not.toContain('autofocus');
  });

  it('binds visible labels and the exact hints', () => {
    for (const label of [
      'Name',
      'Email address',
      'Password',
      'Confirm password',
    ]) {
      expect(html).toContain(`>${label}</label>`);
    }
    expect(html).toContain(
      'This account receives sign-in and password-reset emails.',
    );
    expect(html).toContain('At least 12 characters. A passphrase works well.');
    expect(inputTag(html, 'email')).toContain('aria-describedby="email-hint"');
    expect(inputTag(html, 'password')).toContain(
      'aria-describedby="password-hint"',
    );
  });

  it('has one primary button and no error summary on first load', () => {
    expect(html).toContain('>Create superadmin</button>');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Fix the following and try again');
    expect(html).not.toContain('disabled');
  });

  it('renders the error summary, per-field errors and preserved values', () => {
    const failed = renderSetupForm({
      values: { name: 'Ada', email: 'ada@example.com' },
      issues: allIssues,
    });

    expect(failed).toMatch(
      /<div[^>]*role="alert"[^>]*tabindex="-1"[^>]*autofocus=""|<div[^>]*autofocus=""[^>]*role="alert"/,
    );
    expect(failed).toContain('Fix the following and try again');
    for (const issue of allIssues) {
      expect(failed).toContain(`href="#${issue.field}"`);
      expect(failed).toContain(issue.message);
      const tag = inputTag(failed, issue.field);
      expect(tag).toContain('aria-invalid="true"');
      expect(tag).toContain(`${issue.field}-error`);
    }
    expect(inputTag(failed, 'email')).toContain(
      'aria-describedby="email-hint email-error"',
    );
    expect(inputTag(failed, 'name')).toContain('aria-describedby="name-error"');
    expect(inputTag(failed, 'name')).toContain('value="Ada"');
    expect(inputTag(failed, 'email')).toContain('value="ada@example.com"');
    expect(inputTag(failed, 'password')).not.toMatch(/value="[^"]+"/);
    expect(inputTag(failed, 'passwordConfirm')).not.toMatch(/value="[^"]+"/);
    // Focus goes to the summary, never to a field as well.
    expect(count(failed, 'autofocus')).toBe(1);
  });

  it('marks only the failing fields invalid', () => {
    const failed = renderSetupForm({
      values: { name: 'Ada', email: 'ada@example.com' },
      issues: [allIssues[2] as SetupIssue],
    });
    expect(inputTag(failed, 'password')).toContain('aria-invalid="true"');
    expect(inputTag(failed, 'name')).not.toContain('aria-invalid');
    expect(inputTag(failed, 'email')).not.toContain('aria-invalid');
  });

  it('renders submitted values escaped', () => {
    const hostile = renderSetupForm({
      values: { name: '<script>alert(1)</script>', email: '"><b>' },
      issues: [allIssues[0] as SetupIssue],
    });
    expect(hostile).not.toContain('<script>');
    expect(hostile).not.toContain('"><b>');
    expect(hostile).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('renderSetupUnavailable', () => {
  it('renders the race screen from S1.2', () => {
    const html = renderSetupUnavailable('race');
    expect(html).toContain('<h1>Setup is already complete</h1>');
    expect(html).toContain(
      'Someone created the first account while this page was open. If that was not you, check the installation before continuing.',
    );
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>View your site<\/a>/);
    expect(html).not.toContain('<form');
  });

  it('renders the database screen from S1.2', () => {
    const html = renderSetupUnavailable('database');
    expect(html).toContain('<h1>The database is not ready</h1>');
    expect(html).toContain('<code>pnpm plakboek migrate</code>');
    expect(html).toContain(', then reload this page.');
    expect(html).not.toContain('<form');
  });
});

describe('renderSetupComplete', () => {
  const base = {
    email: 'ada@example.com',
    token: 'payload.signature',
    homePublished: true,
  } as const;

  it('renders the S1.3 copy, the link and the test-email form', () => {
    const html = renderSetupComplete(base);
    expect(html).toContain('<h1>Setup complete</h1>');
    expect(html).toContain(
      'The superadmin account for ada@example.com was created and your home page is published.',
    );
    expect(html).toContain(
      'Sign-in arrives with the editor in a later release, so there is nothing to log in to yet.',
    );
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>View your site<\/a>/);
    expect(html).toContain('Check email delivery');
    expect(html).toContain(
      'Sends a real sign-in email template to ada@example.com.',
    );
    expect(html).toMatch(
      /<form[^>]*action="\/cms\/setup\/test-email"[^>]*method="post"|<form[^>]*method="post"[^>]*action="\/cms\/setup\/test-email"/,
    );
    expect(html).toMatch(
      /<input[^>]*type="hidden"[^>]*name="token"[^>]*value="payload\.signature"|<input[^>]*name="token"[^>]*type="hidden"[^>]*value="payload\.signature"/,
    );
    expect(html).toContain('>Send test email</button>');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('leaves out the published-home claim when there was no seed', () => {
    const html = renderSetupComplete({ ...base, homePublished: false });
    expect(html).toContain(
      'The superadmin account for ada@example.com was created.',
    );
    expect(html).not.toContain('home page is published');
  });

  it('renders the four test-email outcomes from S1.3', () => {
    const sent = renderSetupComplete({ ...base, result: { kind: 'sent' } });
    expect(sent).toMatch(/role="status"[^>]*>[^<]*Test email sent to/);
    expect(sent).toContain(
      'Test email sent to ada@example.com. Check the inbox and the spam folder.',
    );

    const failed = renderSetupComplete({
      ...base,
      result: { kind: 'failed', detail: 'connect ECONNREFUSED 127.0.0.1:1' },
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(
      'The test email could not be sent: connect ECONNREFUSED 127.0.0.1:1. Check the PLAKBOEK_SMTP_* settings and try again. Setup is complete either way.',
    );
    expect(failed).toMatch(/<a[^>]*href="\/"[^>]*>View your site<\/a>/);

    const console_ = renderSetupComplete({
      ...base,
      result: { kind: 'console' },
    });
    expect(console_).toContain('role="status"');
    expect(console_).toContain(
      'No SMTP server is configured, so the email was printed to the server console instead.',
    );

    const production = renderSetupComplete({
      ...base,
      result: { kind: 'unconfigured' },
    });
    expect(production).toContain('role="alert"');
    expect(production).toContain(
      'No SMTP server is configured. Set the PLAKBOEK_SMTP_* variables to send email. Setup is complete either way.',
    );
  });

  it('escapes the email and the transport error', () => {
    const html = renderSetupComplete({
      ...base,
      email: '<i>x</i>@example.com',
      result: { kind: 'failed', detail: '<script>boom</script>' },
    });
    expect(html).not.toContain('<i>x</i>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;boom&lt;/script&gt;');
  });
});

describe('every setup screen', () => {
  it('ships exactly one style element and no script', () => {
    for (const html of everyScreen()) {
      expect(count(html, '<style')).toBe(1);
      expect(html).not.toContain('<script');
    }
  });

  it('is English, light only and noindex', () => {
    for (const html of everyScreen()) {
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('name="robots"');
      expect(html).toContain('<main');
    }
    expect(SETUP_STYLES).toContain('color-scheme:light');
  });

  it('keeps the CSS self-contained and within the S1 contract', () => {
    expect(SETUP_STYLES).not.toContain('@import');
    expect(SETUP_STYLES).not.toContain('url(');
    expect(SETUP_STYLES).not.toContain('transition');
    expect(SETUP_STYLES).toContain('max-width:480px');
    expect(SETUP_STYLES).toContain('height:44px');
    expect(SETUP_STYLES).toContain('overflow-wrap:anywhere');
    expect(SETUP_STYLES).toContain('outline:2px solid #18181b');
    expect(SETUP_STYLES).toContain('outline-offset:2px');
  });
});

describe('SETUP_CSP', () => {
  it('locks the page down', () => {
    expect(SETUP_CSP).toContain("default-src 'none'");
    expect(SETUP_CSP).toContain("form-action 'self'");
    expect(SETUP_CSP).toContain("frame-ancestors 'none'");
    expect(SETUP_CSP).toContain("base-uri 'none'");
    expect(SETUP_CSP).not.toContain('script-src');
  });

  it('allows exactly the inline stylesheet through its hash', () => {
    const hash = createHash('sha256')
      .update(SETUP_STYLES, 'utf8')
      .digest('base64');
    expect(SETUP_CSP).toContain(`style-src 'sha256-${hash}'`);
    expect(SETUP_CSP).not.toContain("'unsafe-inline'");
  });

  it('matches the stylesheet text every screen actually inlines', () => {
    for (const html of everyScreen()) {
      const match = /<style>([\s\S]*?)<\/style>/.exec(html);
      expect(match?.[1]).toBe(SETUP_STYLES);
    }
  });
});
