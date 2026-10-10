/**
 * The login document at `/cms` on a production build, in three engines. The
 * first paint is proven with JavaScript turned off: the blurred real page, the
 * scrim and the card must already be there from the server's markup alone.
 * A second group runs with scripts on: a valid session goes straight to edit
 * mode, and Log out really ends the session.
 */
import { expect, test, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const BACKDROP = `${HOST} iframe`;
const DIALOG = `${HOST} dialog[open]`;
const CARD = `${HOST} .pk-card`;
const EDITOR_FLAG = 'plakboek:editor';
const PILL = 'plakboek-toolbar';

/** Every response under `/cms` the page loaded, with its robots header. */
function watchCmsResponses(
  page: Page,
): { url: string; robots: string | null }[] {
  const seen: { url: string; robots: string | null }[] = [];
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (/^\/cms(\/|$)/i.test(pathname)) {
      seen.push({
        url: response.url(),
        robots: response.headers()['x-robots-tag'] ?? null,
      });
    }
  });
  return seen;
}

test.describe('the login page without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('paints the card over the blurred, inert real page from the server markup alone', async ({
    page,
  }) => {
    const cms = watchCmsResponses(page);
    const response = await page.goto('/cms?next=/about');
    expect(response?.status()).toBe(200);

    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Sign in', level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();

    const backdrop = page.locator(BACKDROP);
    await expect(backdrop).toHaveCSS('filter', /blur\(12px\)/);
    await expect(backdrop).toHaveAttribute('inert', '');
    await expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    await expect(backdrop).toHaveAttribute('src', '/about');

    // The framed document is the real /about page, and no editor pill is in it.
    const framed = page.frameLocator(BACKDROP);
    await expect(framed.getByRole('heading', { name: 'About us' })).toHaveCount(
      1,
    );
    await expect(framed.locator(PILL)).toHaveCount(0);

    // Every /cms response the page saw says noindex.
    expect(cms.length).toBeGreaterThan(0);
    for (const seen of cms) expect(seen.robots).toBe('noindex, nofollow');
  });

  test('fills the viewport with the backdrop and centres a 400px card over it', async ({
    page,
  }) => {
    await page.goto('/cms');
    const viewport = page.viewportSize();
    const backdrop = await page.locator(BACKDROP).boundingBox();
    expect(backdrop).toMatchObject({
      x: 0,
      y: 0,
      width: viewport?.width,
      height: viewport?.height,
    });
    const card = await page.locator(CARD).boundingBox();
    expect(card?.width).toBeCloseTo(400, 0);
    const centre = (card?.x ?? 0) + (card?.width ?? 0) / 2;
    expect(centre).toBeCloseTo((viewport?.width ?? 0) / 2, 0);
    const middle = (card?.y ?? 0) + (card?.height ?? 0) / 2;
    expect(Math.abs(middle - (viewport?.height ?? 0) / 2)).toBeLessThan(2);
  });

  test('is fluid down to 320px wide', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/cms');
    const card = await page.locator(CARD).boundingBox();
    // 16px of viewport padding on each side.
    expect(card?.x).toBeCloseTo(16, 0);
    expect(card?.width).toBeCloseTo(288, 0);
  });

  test('aligns the card to the top with a 24px margin when it is taller than the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 420 });
    await page.goto('/cms');
    const card = await page.locator(CARD).boundingBox();
    expect(card?.y).toBeCloseTo(24, 0);
    expect(card?.height ?? 0).toBeGreaterThan(420 - 48);
  });

  test('falls back to the home page for a next that is not a path on this site', async ({
    page,
  }) => {
    for (const hostile of ['//evil.test', 'https://evil.test']) {
      await page.goto(`/cms?next=${encodeURIComponent(hostile)}`);
      await expect(page.locator(BACKDROP)).toHaveAttribute('src', '/');
    }
  });

  test('shows the invalid link step for a reset link with no token', async ({
    page,
  }) => {
    const cms = watchCmsResponses(page);
    await page.goto('/cms/reset-password');
    await expect(
      page.getByRole('heading', { name: 'This link is no longer valid' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Request a new reset link' }),
    ).toBeVisible();
    expect(cms.every((seen) => seen.robots === 'noindex, nofollow')).toBe(true);
  });

  test('shows the choose-a-password step for a reset link with a token', async ({
    page,
  }) => {
    await page.goto('/cms/reset-password?token=abc123&next=/about');
    await expect(
      page.getByRole('heading', { name: 'Choose a new password' }),
    ).toBeVisible();
    await expect(
      page.getByLabel('New password', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Confirm new password')).toBeVisible();
    await expect(page.locator(BACKDROP)).toHaveAttribute('src', '/about');
    // The token is in the address bar only, not in anything the page holds.
    expect(await page.content()).not.toContain('abc123');
  });

  test('answers an unknown path under /cms with the host 404 and noindex', async ({
    page,
  }) => {
    const response = await page.goto('/cms/nothing-here');
    expect(response?.status()).toBe(404);
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('serves the CMS default robots.txt on a host that ships none', async ({
    page,
  }) => {
    const response = await page.request.get('/robots.txt');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/plain');
    expect(await response.text()).toContain('Disallow: /cms');
  });
});

test.describe('the login page with JavaScript', () => {
  test('keeps the editor pill out of the backdrop even when the browser carries the editor flag', async ({
    page,
  }) => {
    await page.goto('/about');
    await page.evaluate((key) => localStorage.setItem(key, '1'), EDITOR_FLAG);
    await page.goto('/about');
    // The pill shows on the plain page for a browser that carries the flag.
    await expect(page.locator(PILL)).toHaveCount(1);

    await page.goto('/cms?next=/about');
    await expect(page.locator(DIALOG)).toBeVisible();
    const framed = page.frameLocator(BACKDROP);
    await expect(framed.getByRole('heading', { name: 'About us' })).toHaveCount(
      1,
    );
    await expect(framed.locator(PILL)).toHaveCount(0);
    await expect(page.locator(PILL)).toHaveCount(0);
  });

  test('sends a signed-in editor straight to the page in edit mode, with no modal', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.goto('/cms?next=/about');
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '?_edit=1',
    );
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });

  test('sends a superadmin who must set up two-step sign-in to that step', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().superadmin);
    await page.goto('/cms?next=/about');
    await page.waitForURL((url) => url.pathname === '/cms/two-factor/enrol');
    expect(new URL(page.url()).searchParams.get('next')).toBe('/about');
    await expect(
      page.getByRole('heading', { name: 'Set up two-step sign-in' }),
    ).toBeVisible();
    await expect(page.locator(BACKDROP)).toHaveAttribute('src', '/about');
  });

  test('Log out ends the session on the server and returns to the plain page', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    await page.getByRole('button', { name: 'Log out' }).first().click();
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '',
    );

    // The session is gone: the edit page bounces back, and /cms asks to sign in.
    await page.goto('/about?_edit=1');
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '',
    );
    await page.goto('/cms?next=/about');
    await expect(page.locator(DIALOG)).toBeVisible();
  });
});
