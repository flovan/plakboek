/**
 * Two-step sign-in set-up in the login modal, in three engines: a superadmin
 * who has not set it up signs in, confirms the password, adds the key to an
 * authenticator (here, the test computes the code the app would show), saves
 * the backup codes and lands in the shell. The gate holds throughout: until
 * the first code has been accepted, edit mode still redirects to the set-up.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { signIn } from './helpers/session.ts';
import { totp, wrongTotp } from './helpers/totp.ts';
import { createTestUser, type TestUser } from './helpers/users.ts';

const HOST = 'plakboek-editor';
const EDITOR_FLAG = 'plakboek:editor';
const ENROL_PATH = '/cms/two-factor/enrol';

/** A browser context of its own: no cookies shared with any other. */
async function freshContext(
  browser: Browser,
  baseURL: string | undefined,
): Promise<BrowserContext> {
  return await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    viewport: { width: 1400, height: 900 },
  });
}

async function openModal(page: Page): Promise<void> {
  await page.goto('/cms?next=/about');
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
}

async function signInWithPassword(page: Page, user: TestUser): Promise<void> {
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in at `/cms` and waits for the set-up step the card moves on to. */
async function signInToEnrolment(page: Page, user: TestUser): Promise<void> {
  await openModal(page);
  await signInWithPassword(page, user);
  await page.waitForURL(
    (url) => url.pathname === ENROL_PATH && url.search === '?next=%2Fabout',
  );
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
  await expect(
    page.getByRole('heading', { name: 'Set up two-step sign-in' }),
  ).toBeVisible();
}

async function confirmPassword(page: Page, password: string): Promise<void> {
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Everything the page keeps in the browser's own storage, as one string. */
async function storedText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const read = (storage: Storage): Record<string, string | null> =>
      Object.fromEntries(
        Object.keys(storage).map((key) => [key, storage.getItem(key)]),
      );
    return JSON.stringify({
      local: read(localStorage),
      session: read(sessionStorage),
    });
  });
}

/** The setup key the card shows, without its spaces. */
async function shownSecret(page: Page): Promise<string> {
  const text = await page.locator('#plakboek-enrol-key').innerText();
  return text.replace(/\s+/g, '');
}

test.describe('two-step sign-in set-up', () => {
  test('a superadmin who has not set it up cannot edit, sets it up in the modal and lands in the shell', async ({
    page,
    browser,
    baseURL,
  }) => {
    const user = await createTestUser({ roleKey: 'superadmin' });

    // The gate: a signed-in superadmin with no second factor is sent to the
    // set-up step, never to the shell.
    const holder = await freshContext(browser, baseURL);
    try {
      const gated = await holder.newPage();
      await signIn(gated, user);
      const redirected = await gated.request.get('/about?_edit=1', {
        maxRedirects: 0,
      });
      expect(redirected.status()).toBe(302);
      expect(redirected.headers().location).toBe(`${ENROL_PATH}?next=%2Fabout`);
    } finally {
      await holder.close();
    }

    // A fresh context signs in from the modal and is moved on to the set-up.
    await signInToEnrolment(page, user);
    const heading = page.getByRole('heading', {
      name: 'Set up two-step sign-in',
    });

    // A wrong password shows its message, clears the field, stays here.
    await confirmPassword(page, 'not the password at all');
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('That password is not correct. Try again.');
    await expect(alert).toBeFocused();
    await expect(page.getByLabel('Password')).toHaveValue('');
    await expect(heading).toBeVisible();

    // The right one reveals the key.
    await confirmPassword(page, user.password);
    const keyHeading = page.getByRole('heading', {
      name: 'Add this site to your authenticator app',
    });
    await expect(keyHeading).toBeFocused();
    const grouped = (
      await page.locator('#plakboek-enrol-key').innerText()
    ).trim();
    expect(grouped).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);
    const secret = await shownSecret(page);
    const link = page.getByRole('link', { name: 'Open in authenticator app' });
    const href = (await link.getAttribute('href')) ?? '';
    expect(href.startsWith('otpauth://totp/')).toBe(true);
    expect(new URL(href).searchParams.get('secret')).toBe(secret);

    // Until a code has been accepted the gate has not moved.
    const stillGated = await page.request.get('/about?_edit=1', {
      maxRedirects: 0,
    });
    expect(stillGated.status()).toBe(302);
    expect(stillGated.headers().location).toBe(`${ENROL_PATH}?next=%2Fabout`);

    // A wrong code says so and keeps the step and the field.
    const wrong = wrongTotp(secret);
    await page.getByLabel('Authentication code').fill(wrong);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'That code is not valid or has expired. Check it and try again.',
    );
    await expect(page.getByLabel('Authentication code')).toHaveValue(wrong);
    await expect(keyHeading).toBeVisible();

    // The code the authenticator shows is accepted; the backup codes follow.
    await page.getByLabel('Authentication code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    const backupHeading = page.getByRole('heading', {
      name: 'Save your backup codes',
    });
    await expect(backupHeading).toBeFocused();
    const codes = (await page.getByRole('listitem').allInnerTexts()).map(
      (code) => code.trim(),
    );
    expect(codes.length).toBeGreaterThanOrEqual(5);
    for (const code of codes) expect(code).not.toBe('');

    // Neither the key nor a backup code is in the address or in storage.
    const stored = await storedText(page);
    const address = page.url();
    for (const secretValue of [secret, ...codes]) {
      expect(stored).not.toContain(secretValue);
      expect(address).not.toContain(secretValue);
    }

    // Acknowledging hands over to the shell.
    await page.getByRole('button', { name: 'I have saved my codes' }).click();
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(page.locator(`${HOST} iframe`)).toHaveAttribute(
      'src',
      /_edit=frame$/,
    );
    const afterwards = await storedText(page);
    for (const secretValue of [secret, ...codes]) {
      expect(afterwards).not.toContain(secretValue);
    }
    expect(
      await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
    ).toBe('1');

    // The next sign-in, from a context with no session, asks for the code.
    const later = await freshContext(browser, baseURL);
    try {
      const again = await later.newPage();
      await openModal(again);
      await signInWithPassword(again, user);
      await expect(
        again.getByRole('heading', { name: 'Enter your code' }),
      ).toBeFocused();
      await again.getByLabel('Authentication code').fill(totp(secret));
      await again.getByRole('button', { name: 'Verify' }).click();
      await again.waitForURL(
        (url) => url.pathname === '/about' && url.search === '?_edit=1',
      );
    } finally {
      await later.close();
    }
  });
});
