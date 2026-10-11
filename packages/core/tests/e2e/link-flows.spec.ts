/**
 * Every emailed-link step of the login modal, in three engines: forgotten
 * password, the reset and invitation landings, sign-in links and the shared
 * invalid-link step. Links are issued through the same auth engine the server
 * runs (see `helpers/links.ts`), for accounts the spec creates itself, so a
 * spent link or a changed password never affects another spec.
 */
import { expect, test, type Page } from '@playwright/test';
import { issueMagicLink, issuePasswordLink } from './helpers/links.ts';
import { createTestUser, type TestUser } from './helpers/users.ts';

const HOST = 'plakboek-editor';
const EDITOR_FLAG = 'plakboek:editor';

const RATE_LIMITED = 'Too many attempts. Wait a few minutes, then try again.';
const NEW_PASSWORD = 'a brand new passphrase for the test';

async function openModal(page: Page, path = '/cms?next=/about'): Promise<void> {
  await page.goto(path);
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
}

/** The token a site-relative link carries. */
function tokenOf(link: string): string {
  const token = new URL(link, 'http://site.test').searchParams.get('token');
  if (token === null) throw new Error('The issued link has no token');
  return token;
}

async function chooseNewPassword(
  page: Page,
  password: string,
  confirmation = password,
): Promise<void> {
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password').fill(confirmation);
}

async function waitForEditMode(page: Page, path = '/about'): Promise<void> {
  await page.waitForURL(
    (url) => url.pathname === path && url.search === '?_edit=1',
  );
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
  ).toBe('1');
}

async function signInWith(page: Page, account: TestUser): Promise<void> {
  await page.getByLabel('Email address').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** What the sent state says, with the address replaced so two can be compared. */
async function sentCopy(page: Page, email: string): Promise<string> {
  const heading = page.getByRole('heading', { name: 'Check your email' });
  await expect(heading).toBeFocused();
  const card = page.locator(`${HOST} .pk-card`);
  return (await card.innerText()).split(email).join('{email}');
}

test.describe('forgotten password', () => {
  test('answers a registered and an unregistered address with the same state', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const stranger = 'nobody-here-9f3a@example.com';

    await openModal(page);
    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    const heading = page.getByRole('heading', { name: 'Reset your password' });
    await expect(heading).toBeFocused();

    // A malformed address is caught before anything is sent.
    await page.getByLabel('Email address').fill('not an address');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(
      page.getByText('Enter an address like name@example.com.'),
    ).toBeVisible();

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/password-link/request')) {
        requests.push(request.postData() ?? '');
      }
    });

    await page.getByLabel('Email address').fill(user.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const registered = await sentCopy(page, user.email);
    expect(registered).toContain(
      'If an account exists for {email}, a reset link is on its way. The link works once.',
    );
    // `next` rides along so the emailed link returns to the page.
    expect(JSON.parse(requests[0] ?? '{}')).toEqual({
      email: user.email,
      next: '/about',
    });

    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();

    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    await page.getByLabel('Email address').fill(stranger);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const unregistered = await sentCopy(page, stranger);
    expect(unregistered).toBe(registered);
  });

  test('a long address wraps instead of widening the card', async ({
    page,
  }) => {
    const long = `${'a'.repeat(120)}@example.com`;
    await openModal(page);
    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    await page.getByLabel('Email address').fill(long);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(
      page.getByRole('heading', { name: 'Check your email' }),
    ).toBeVisible();
    const box = await page.locator(`${HOST} .pk-card`).boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(400);
    const overflow = await page.evaluate((tag) => {
      const card = document
        .querySelector(tag)
        ?.shadowRoot?.querySelector('.pk-card');
      return card === null || card === undefined
        ? null
        : card.scrollWidth - card.clientWidth;
    }, HOST);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('shows the rate-limited copy in the error box when the endpoint answers 429', async ({
    page,
  }) => {
    await openModal(page);
    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    await page.route('**/api/auth/plakboek/password-link/request', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: '{"message":"Too many requests. Please try again later."}',
      }),
    );
    await page.getByLabel('Email address').fill('someone@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(RATE_LIMITED);
    await expect(alert).toBeFocused();
    await expect(page.getByLabel('Email address')).toHaveValue(
      'someone@example.com',
    );
  });
});

test.describe('the reset landing', () => {
  test('removes the token at once, sets the password, returns to sign-in and signs in', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const link = await issuePasswordLink(
      user.email,
      'reset-password',
      '/about',
    );
    const token = tokenOf(link);

    const referers: Promise<string | undefined>[] = [];
    page.on('request', (request) => {
      referers.push(request.allHeaders().then((headers) => headers.referer));
    });

    await openModal(page, link);
    const heading = page.getByRole('heading', {
      name: 'Choose a new password',
    });
    await expect(heading).toBeVisible();

    // The address bar and the history entry no longer carry the token, and
    // `next` is still there.
    const address = new URL(page.url());
    expect(address.pathname).toBe('/cms/reset-password');
    expect(address.search).toBe('?next=%2Fabout');
    expect(page.url()).not.toContain(token);
    expect(await page.evaluate(() => location.href)).not.toContain(token);

    // Nothing the page loaded (the backdrop iframe included) was given the
    // token in a Referer.
    const seen = await Promise.all(referers);
    expect(seen.length).toBeGreaterThan(1);
    for (const referer of seen) {
      expect(referer ?? '').not.toContain(token);
    }

    // The card checks length and agreement before it sends anything.
    await chooseNewPassword(page, 'short');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
    await chooseNewPassword(page, NEW_PASSWORD, `${NEW_PASSWORD} typo`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(
      page.getByText('The two passwords do not match.'),
    ).toBeVisible();

    // The link survived those attempts: a good one spends it.
    await chooseNewPassword(page, NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();
    await expect(page.getByRole('status')).toHaveText(
      'Your password has been reset. Sign in to continue.',
    );

    // The old password no longer works; the new one does, and `next` is kept.
    await signInWith(page, user);
    await expect(page.getByRole('alert')).toHaveText(
      'Email or password is incorrect. Check them and try again.',
    );
    await signInWith(page, { ...user, password: NEW_PASSWORD });
    await waitForEditMode(page);
  });

  test('says the link is no longer valid when it is used again, and offers a new reset link', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const link = await issuePasswordLink(
      user.email,
      'reset-password',
      '/about',
    );

    await openModal(page, link);
    await chooseNewPassword(page, NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();

    // The same link again: the landing cannot know it is spent until the
    // password is sent.
    await openModal(page, link);
    await chooseNewPassword(page, `${NEW_PASSWORD} again`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    const invalid = page.getByRole('heading', {
      name: 'This link is no longer valid',
    });
    await expect(invalid).toBeFocused();
    await expect(
      page.getByText(
        'Links work once and expire after a while. Request a new one to continue.',
      ),
    ).toBeVisible();

    await page
      .getByRole('button', { name: 'Request a new reset link' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Reset your password' }),
    ).toBeFocused();
  });

  test('a link without a token is the same invalid-link step, with the reset button', async ({
    page,
  }) => {
    await openModal(page, '/cms/reset-password?next=/about');
    await expect(
      page.getByRole('heading', { name: 'This link is no longer valid' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Request a new reset link' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Reset your password' }),
    ).toBeFocused();
  });
});

test.describe('the invitation landing', () => {
  test('sets the first password and returns to sign-in with the success line', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const link = await issuePasswordLink(user.email, 'set-password', '/about');

    await openModal(page, link);
    await expect(
      page.getByRole('heading', { name: 'Choose a password' }),
    ).toBeVisible();
    expect(page.url()).not.toContain(tokenOf(link));

    await chooseNewPassword(page, NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();
    await expect(page.getByRole('status')).toHaveText(
      'Your password is set. Sign in to continue.',
    );

    await signInWith(page, { ...user, password: NEW_PASSWORD });
    await waitForEditMode(page);
  });

  test('a link without a token says to ask for a new invitation and goes back to sign-in', async ({
    page,
  }) => {
    await openModal(page, '/cms/set-password?next=/about');
    await expect(
      page.getByText(
        'Ask the person who invited you to send a new invitation.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();
  });
});

test.describe('sign-in links', () => {
  test('are requested from the sign-in step and answered the same for any address', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const stranger = 'nobody-here-4c1e@example.com';

    await openModal(page);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(
      page.getByRole('heading', { name: 'Email me a sign-in link' }),
    ).toBeFocused();
    // The two-factor rule is stated in general, never about an address.
    await expect(
      page.getByText(
        'Accounts that sign in with a code from an authenticator app cannot use sign-in links.',
      ),
    ).toBeVisible();

    await page.getByLabel('Email address').fill(user.email);
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    const registered = await sentCopy(page, user.email);
    expect(registered).toContain(
      'If an account exists for {email}, a sign-in link is on its way. The link works once.',
    );

    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await page.getByLabel('Email address').fill(stranger);
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    expect(await sentCopy(page, stranger)).toBe(registered);
  });

  test('shows the rate-limited copy in the error box when the endpoint answers 429', async ({
    page,
  }) => {
    await openModal(page);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await page.route('**/api/auth/sign-in/magic-link', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: '{"message":"Too many requests. Please try again later."}',
      }),
    );
    await page.getByLabel('Email address').fill('someone@example.com');
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(RATE_LIMITED);
    await expect(alert).toBeFocused();
  });

  test('land on "Signing you in" over the blurred page and open it in edit mode', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const link = await issueMagicLink(user.email, '/about');

    // Hold the session read back so the landing can be seen.
    await page.route('**/api/auth/get-session', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto(link);
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(
      page.getByRole('heading', { name: 'Signing you in' }),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Signing you in.');
    // The page behind the card is the one the link was requested from.
    await expect(page.locator(`${HOST} iframe.pk-backdrop`)).toHaveAttribute(
      'src',
      /\/about/,
    );

    await waitForEditMode(page);
    await expect(page.locator(`${HOST} iframe`)).toHaveAttribute(
      'src',
      /_edit=frame$/,
    );
  });

  test('a tampered or reused link is the invalid-link step with a button for a new sign-in link', async ({
    page,
  }) => {
    const user = await createTestUser({ roleKey: 'editor' });
    const link = await issueMagicLink(user.email, '/about');

    // A token that was never issued.
    const tampered = link.replace(/token=[^&]+/, 'token=not-a-real-token');
    await page.goto(tampered);
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(
      page.getByRole('heading', { name: 'This link is no longer valid' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Request a new sign-in link' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Email me a sign-in link' }),
    ).toBeFocused();

    // The real link works once...
    await page.goto(link);
    await waitForEditMode(page);

    // ...and not again, in a browser that holds no session.
    const second = await page.context().browser()?.newContext({
      baseURL: process.env.E2E_BASE_URL,
    });
    if (second === undefined) throw new Error('no second context');
    try {
      const other = await second.newPage();
      await other.goto(link);
      await expect(other.locator(HOST)).toHaveAttribute('data-hydrated', '');
      await expect(
        other.getByRole('heading', { name: 'This link is no longer valid' }),
      ).toBeVisible();
    } finally {
      await second.close();
    }
  });
});

test.describe('the landing without a session', () => {
  test('is the invalid-link step for sign-in links', async ({ page }) => {
    await openModal(page, '/cms/magic-link?next=/about');
    await expect(
      page.getByRole('heading', { name: 'This link is no longer valid' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Request a new sign-in link' }),
    ).toBeVisible();
  });
});
