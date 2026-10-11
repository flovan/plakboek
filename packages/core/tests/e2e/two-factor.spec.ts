/**
 * Two-step sign-in in the login modal, in three engines: the authenticator
 * code, a wrong one, the emailed-code step, and the lockout after too many
 * wrong codes. Accounts are the spec's own (created and enrolled through the
 * real auth API), so a locked account never affects another spec.
 */
import {
  expect,
  test,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { totp, wrongTotp } from './helpers/totp.ts';
import {
  createTestUser,
  enrolTwoFactor,
  type TestUser,
} from './helpers/users.ts';

const HOST = 'plakboek-editor';
const EDITOR_FLAG = 'plakboek:editor';

type EnrolledUser = { readonly user: TestUser; readonly secret: string };

function siteOrigin(): string {
  const origin = process.env.E2E_BASE_URL;
  if (origin === undefined || origin.length === 0) {
    throw new Error('E2E_BASE_URL is not set: global setup did not run');
  }
  return origin;
}

/** A new editor with an authenticator enrolled. */
async function enrolledEditor(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<EnrolledUser> {
  const user = await createTestUser({ roleKey: 'editor' });
  const request = await playwright.request.newContext();
  try {
    const { secret } = await enrolTwoFactor(request, siteOrigin(), user);
    return { user, secret };
  } finally {
    await request.dispose();
  }
}

async function openModal(page: Page): Promise<void> {
  await page.goto('/cms?next=/about');
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
}

/** Fills and submits the password step. */
async function signInWithPassword(page: Page, user: TestUser): Promise<void> {
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Authentication code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
}

test.describe('two-step sign-in', () => {
  let shared: EnrolledUser;

  test.beforeAll(async ({ playwright }) => {
    shared = await enrolledEditor(playwright);
  });

  test('asks for the authenticator code after the password and then opens the framed shell', async ({
    page,
  }) => {
    await openModal(page);
    await signInWithPassword(page, shared.user);

    // The step change moves focus to the new heading.
    const heading = page.getByRole('heading', { name: 'Enter your code' });
    await expect(heading).toBeFocused();
    await expect(
      page.getByText('Enter the 6-digit code from your authenticator app.'),
    ).toBeVisible();
    const field = page.getByLabel('Authentication code');
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(field).toHaveAttribute('maxlength', '7');

    await submitCode(page, totp(shared.secret));
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(page.locator(`${HOST} iframe`)).toHaveAttribute(
      'src',
      /_edit=frame$/,
    );
    expect(
      await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
    ).toBe('1');
  });

  test('accepts a code pasted the way the app shows it, with a space in the middle', async ({
    page,
  }) => {
    await openModal(page);
    await signInWithPassword(page, shared.user);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();

    const code = totp(shared.secret);
    await page.getByLabel('Authentication code').focus();
    // `insertText` is subject to the field's maxlength, as a paste is.
    await page.keyboard.insertText(`${code.slice(0, 3)} ${code.slice(3)}`);
    await expect(page.getByLabel('Authentication code')).toHaveValue(
      `${code.slice(0, 3)} ${code.slice(3)}`,
    );
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
  });

  test('says a wrong code is not valid, keeps the field and lets the right code through', async ({
    page,
  }) => {
    await openModal(page);
    await signInWithPassword(page, shared.user);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();

    const wrong = wrongTotp(shared.secret);
    await submitCode(page, wrong);
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(
      'That code is not valid or has expired. Check it and try again.',
    );
    await expect(alert).toBeFocused();
    await expect(page.getByLabel('Authentication code')).toHaveValue(wrong);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeVisible();

    await submitCode(page, totp(shared.secret));
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
  });

  test('checks the code is six digits before sending anything', async ({
    page,
  }) => {
    await openModal(page);
    await signInWithPassword(page, shared.user);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();

    const verifications: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/two-factor/')) {
        verifications.push(request.url());
      }
    });
    for (const typed of ['', '12a456', '12345']) {
      await submitCode(page, typed);
      await expect(page.getByText('Enter the 6-digit code.')).toBeVisible();
      await expect(page.getByLabel('Authentication code')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    }
    expect(verifications).toEqual([]);
  });

  test('offers an emailed code instead, and the way back to the authenticator', async ({
    page,
  }) => {
    await openModal(page);
    await signInWithPassword(page, shared.user);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();

    await page.getByRole('button', { name: 'Email me a code instead' }).click();
    const heading = page.getByRole('heading', { name: 'Check your email' });
    await expect(heading).toBeFocused();
    // The address is shown masked: its first character and its domain.
    await expect(
      page.getByText('We emailed a 6-digit code to e***@example.com.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Resend code' }),
    ).toBeVisible();

    // A wrong emailed code gets the same code error.
    await submitCode(page, wrongTotp(shared.secret));
    await expect(page.getByRole('alert')).toHaveText(
      'That code is not valid or has expired. Check it and try again.',
    );

    await page
      .getByRole('button', { name: 'Use your authenticator app instead' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();
    await submitCode(page, totp(shared.secret));
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
  });

  test('ends on the lockout step after five wrong codes, and Back to sign in starts again', async ({
    page,
    playwright,
  }) => {
    const { user, secret } = await enrolledEditor(playwright);
    await openModal(page);
    await signInWithPassword(page, user);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();

    const wrong = wrongTotp(secret);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await submitCode(page, wrong);
      await expect(page.getByRole('alert')).toBeFocused();
      await expect(
        page.getByRole('heading', { name: 'Enter your code' }),
      ).toBeVisible();
    }
    await submitCode(page, wrong);
    const lockout = page.getByRole('heading', {
      name: 'Too many incorrect codes',
    });
    await expect(lockout).toBeFocused();
    await expect(page.getByText('Sign in again to continue.')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/cms');

    // Back to sign in: a fresh sign-in step with empty fields.
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(
      page.getByRole('heading', { name: 'Sign in', level: 1 }),
    ).toBeFocused();
    await expect(page.getByLabel('Email address')).toHaveValue('');
    await expect(page.getByLabel('Password')).toHaveValue('');

    // The server holds the lock: the right password and the right code now
    // reach the lockout step again instead of the shell.
    await signInWithPassword(page, user);
    await expect(
      page.getByRole('heading', { name: 'Enter your code' }),
    ).toBeFocused();
    await submitCode(page, totp(secret));
    await expect(
      page.getByRole('heading', { name: 'Too many incorrect codes' }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/cms');
  });
});
