/**
 * How the edit shell treats navigation and its own exits, on a production
 * build, in three engines: links clicked in the framed site, a frame that
 * navigates itself, the failure and narrow-window panels, the page title, and
 * Exit edit mode and Log out.
 */
import { expect, test, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const FRAME = `${HOST} iframe`;
const SIDEBAR_BODY = `${HOST} [data-sidebar]`;
const RAIL = `${HOST} [data-rail]`;
const EDITOR_FLAG = 'plakboek:editor';
const PILL = 'plakboek-toolbar';

/** What a logout answer does for the browser: leave for the plain page. A
 * real 303 cannot be fulfilled from a route in WebKit, so the double answers
 * with a document that moves on at once. */
const LOGOUT_ANSWER = {
  status: 200,
  contentType: 'text/html',
  headers: { 'Cache-Control': 'no-store' },
  body: '<!DOCTYPE html><meta http-equiv="refresh" content="0; url=/about">',
} as const;

async function openShell(page: Page, path: string): Promise<void> {
  await signIn(page, e2eUsers().editor);
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
}

/** Marks the shell document, so a later check can tell it was not reloaded. */
async function markShell(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __shellMarker?: number }).__shellMarker = 1;
  });
}

async function shellMarker(page: Page): Promise<number | undefined> {
  return await page.evaluate(
    () => (window as Window & { __shellMarker?: number }).__shellMarker,
  );
}

/** Reads the shell page's current location relative to the origin. */
function locationOf(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

test.describe('a link clicked in the framed site', () => {
  test('to another page of the site navigates the whole page, still in edit mode', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const framed = page.frameLocator(FRAME);

    await framed.getByRole('link', { name: 'About', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/about');
    expect(locationOf(page)).toBe('/about?_edit=1');

    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(
      page.frameLocator(FRAME).getByRole('heading', { name: 'About us' }),
    ).toBeVisible();
  });

  test('to another site opens a new tab that cannot reach back, and the shell stays', async ({
    page,
    context,
  }) => {
    await context.route('https://example.invalid/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><title>Elsewhere</title><p>Elsewhere</p>',
      }),
    );
    await openShell(page, '/?_edit=1');
    await markShell(page);

    const popupOpened = page.waitForEvent('popup');
    await page
      .frameLocator(FRAME)
      .getByRole('link', { name: 'Elsewhere' })
      .click();
    const popup = await popupOpened;
    await popup.waitForLoadState();

    expect(popup.url()).toBe('https://example.invalid/elsewhere');
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(locationOf(page)).toBe('/?_edit=1');
    expect(await shellMarker(page)).toBe(1);
  });

  test('with a double-slash path stays on the site instead of leaving for another host', async ({
    page,
    context,
  }) => {
    const reached: string[] = [];
    await context.route('https://example.invalid/**', (route) => {
      reached.push(route.request().url());
      return route.abort();
    });
    await openShell(page, '/?_edit=1');
    const origin = new URL(page.url()).origin;

    await page
      .frameLocator(FRAME)
      .getByRole('link', { name: 'Double slash' })
      .click();
    await page.waitForURL(
      (url) => url.pathname === '/example.invalid/double-slash',
    );

    expect(new URL(page.url()).origin).toBe(origin);
    expect(locationOf(page)).toBe('/example.invalid/double-slash?_edit=1');
    expect(reached).toEqual([]);
  });

  test('to a file of the site opens a new tab and the shell stays', async ({
    page,
    context,
  }) => {
    await context.route('**/uploads/report.pdf', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><title>Report</title><p>Report</p>',
      }),
    );
    await openShell(page, '/?_edit=1');
    await markShell(page);

    const popupOpened = page.waitForEvent('popup');
    await page
      .frameLocator(FRAME)
      .getByRole('link', { name: 'Report' })
      .click();
    const popup = await popupOpened;
    await popup.waitForLoadState();

    expect(new URL(popup.url()).pathname).toBe('/uploads/report.pdf');
    expect(locationOf(page)).toBe('/?_edit=1');
    expect(await shellMarker(page)).toBe(1);
  });

  test('to the page already shown reloads the frame instead of doing nothing', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    await markShell(page);
    const handle = await page.locator(FRAME).elementHandle();
    const frame = await handle?.contentFrame();
    if (frame === null || frame === undefined) {
      throw new Error('The shell has no framed document');
    }
    await frame.evaluate(() => {
      (window as Window & { __frameMarker?: number }).__frameMarker = 1;
    });

    await page
      .frameLocator(FRAME)
      .getByRole('link', { name: 'Adversarial fixture', exact: true })
      .click();

    await expect
      .poll(() =>
        frame.evaluate(
          () => (window as Window & { __frameMarker?: number }).__frameMarker,
        ),
      )
      .toBeUndefined();
    expect(locationOf(page)).toBe('/?_edit=1');
    expect(await shellMarker(page)).toBe(1);
    expect(frame.url()).toContain('_edit=frame');
  });

  test('to a spot on the same page scrolls the frame and leaves the page alone', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    await markShell(page);
    const handle = await page.locator(FRAME).elementHandle();
    const frame = await handle?.contentFrame();
    if (frame === null || frame === undefined) {
      throw new Error('The shell has no framed document');
    }
    expect(await frame.evaluate(() => window.scrollY)).toBe(0);

    await page
      .frameLocator(FRAME)
      .getByRole('link', { name: 'Footer', exact: true })
      .click();

    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    expect(locationOf(page)).toBe('/?_edit=1');
    expect(await shellMarker(page)).toBe(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("that the site's own script handles is left to the site", async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    await markShell(page);
    const framed = page.frameLocator(FRAME);

    // A link whose script prevents the default: the shell does not follow it.
    await framed.getByRole('link', { name: 'Handled link' }).click();
    await expect(framed.locator('body')).toHaveAttribute(
      'data-handled',
      'true',
    );
    expect(locationOf(page)).toBe('/?_edit=1');
    expect(await shellMarker(page)).toBe(1);

    // A button whose script prevents the default and drives an accordion.
    const trigger = framed.locator('[data-accordion] button').first();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(locationOf(page)).toBe('/?_edit=1');
  });
});

test.describe('a frame that navigates itself', () => {
  test('is followed by the whole page, in edit mode', async ({ page }) => {
    await openShell(page, '/?_edit=1');
    const handle = await page.locator(FRAME).elementHandle();
    const frame = await handle?.contentFrame();
    if (frame === null || frame === undefined) {
      throw new Error('The shell has no framed document');
    }

    // A site script moving the frame to another page, as a form post would.
    await frame.evaluate(() => {
      window.location.href = '/about';
    });

    await page.waitForURL((url) => url.pathname === '/about');
    expect(locationOf(page)).toBe('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(
      page.frameLocator(FRAME).getByRole('heading', { name: 'About us' }),
    ).toBeVisible();
  });
});

test.describe('a page that cannot be shown', () => {
  test('shows the shell panel with a reload button and no error detail', async ({
    page,
  }) => {
    await openShell(page, '/broken?_edit=1');

    const panel = page.locator(`${HOST} [role="alert"]`);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(
      'This page could not be shown in edit mode',
    );
    await expect(panel).toContainText('Reload to try again.');
    await expect(page.locator(FRAME)).toBeHidden();
    const text = (await panel.textContent()) ?? '';
    expect(text).not.toMatch(/cannot render|\bstack\b|Error:/i);

    // The failure page itself carries only a marker.
    const framePage = await page.request.get('/broken?_edit=frame');
    expect(framePage.status()).toBe(500);
    const body = await framePage.text();
    expect(body).toContain('plakboek-frame-error');
    expect(body).not.toMatch(/cannot render|\bstack\b/i);

    // Reload page reloads the whole page.
    const reloaded = page.waitForRequest(
      (request) =>
        request.resourceType() === 'document' &&
        request.url().endsWith('/broken?_edit=1'),
    );
    await panel.getByRole('button', { name: 'Reload page' }).click();
    await reloaded;
  });

  test('renders the host not-found page inside the frame for a page that does not exist', async ({
    page,
  }) => {
    await openShell(page, '/no-such-page?_edit=1');
    await expect(
      page.frameLocator(FRAME).getByRole('heading', { name: 'Page not found' }),
    ).toBeVisible();
    await expect(page.locator(`${HOST} [role="alert"]`)).toHaveCount(0);
    await expect(page.locator(FRAME)).toBeVisible();
  });
});

test.describe('a window narrower than 1024px', () => {
  test('shows the narrow-window panel instead of the frame, and lifts it on growing', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await markShell(page);

    const panel = page.locator(`${HOST} [role="status"]`);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Editing needs a wider window');
    await expect(panel).toContainText('at least 1024 pixels wide');
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expect(page.locator(FRAME)).toBeHidden();
    // Exit edit mode is still there: it is the action the panel points to.
    await expect(
      page.locator(`${SIDEBAR_BODY} a`, { hasText: 'Exit edit mode' }),
    ).toBeVisible();

    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(panel).toBeHidden();
    await expect(page.locator(FRAME)).toBeVisible();

    await page.setViewportSize({ width: 1200, height: 900 });
    await expect(panel).toBeHidden();
    await expect(page.locator(FRAME)).toBeVisible();
    expect(await shellMarker(page)).toBe(1);

    await page.setViewportSize({ width: 1023, height: 900 });
    await expect(panel).toBeVisible();
    await expect(page.locator(FRAME)).toBeHidden();
  });

  test('is shown before any script has run', async ({ page }) => {
    await signIn(page, e2eUsers().editor);
    await page.route('**/assets/plakboek-editor-*', (route) => route.abort());
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto('/about?_edit=1');

    await expect(page.locator(HOST)).not.toHaveAttribute('data-hydrated', '');
    await expect(page.locator(`${HOST} [role="status"]`)).toBeVisible();
    await expect(page.locator(FRAME)).toBeHidden();
  });
});

test.describe('the page title', () => {
  test("is the framed page's title followed by the product name", async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');
    await expect(page).toHaveTitle(/^.+ · Plakboek$/);
    const framedTitle = await page
      .frameLocator(FRAME)
      .locator('head > title')
      .evaluate((element) => element.textContent);
    await expect(page).toHaveTitle(`${framedTitle} · Plakboek`);
  });

  test('is the product name alone for a page that fails to render', async ({
    page,
  }) => {
    await openShell(page, '/broken?_edit=1');
    await expect(page.locator(`${HOST} [role="alert"]`)).toBeVisible();
    await expect(page).toHaveTitle('Plakboek');
  });
});

test.describe('leaving edit mode', () => {
  test('Exit edit mode keeps the session and the editor flag, so the pill shows', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.goto('/about');
    await page.evaluate((key) => localStorage.setItem(key, '1'), EDITOR_FLAG);
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    await page
      .locator(`${SIDEBAR_BODY} a`, { hasText: 'Exit edit mode' })
      .click();
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '',
    );
    expect(locationOf(page)).toBe('/about');
    await expect(page.locator(PILL)).toHaveCount(1);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
    ).toBe('1');

    // The session is still there: the edit page opens again.
    const again = await page.goto('/about?_edit=1');
    expect(again?.status()).toBe(200);
    await expect(page.locator(HOST)).toHaveCount(1);
  });

  test('Log out posts to the logout path with the visitor location, clears the editor flag and lands on the plain page', async ({
    page,
  }) => {
    // The logout endpoint itself is served by the CMS routes; what this
    // spec holds is the shell's half of the contract: the request it sends,
    // the flag it clears and where the browser ends up afterwards.
    let posted: { method: string; body: string } | null = null;
    await page.route('**/cms/logout', async (route) => {
      const request = route.request();
      posted = { method: request.method(), body: request.postData() ?? '' };
      await route.fulfill(LOGOUT_ANSWER);
    });
    await signIn(page, e2eUsers().editor);
    await page.goto('/about');
    await page.evaluate((key) => localStorage.setItem(key, '1'), EDITOR_FLAG);
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    await page.locator(`${SIDEBAR_BODY} form button[type="submit"]`).click();
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '',
    );

    expect(locationOf(page)).toBe('/about');
    expect(posted).toEqual({ method: 'POST', body: 'next=%2Fabout' });
    expect(
      await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
    ).toBeNull();
    await expect(page.locator(PILL)).toHaveCount(0);
  });

  test('Log out from the rail clears the flag in the same way', async ({
    page,
  }) => {
    await page.route('**/cms/logout', (route) => route.fulfill(LOGOUT_ANSWER));
    await signIn(page, e2eUsers().editor);
    await page.goto('/about');
    await page.evaluate(
      ([flag, layout]) => {
        localStorage.setItem(flag ?? '', '1');
        localStorage.setItem(layout ?? '', 'full');
      },
      [EDITOR_FLAG, 'plakboek:editor-layout'],
    );
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    await page.locator(`${RAIL} form button[type="submit"]`).click();
    await page.waitForURL(
      (url) => url.pathname === '/about' && url.search === '',
    );

    expect(
      await page.evaluate((key) => localStorage.getItem(key), EDITOR_FLAG),
    ).toBeNull();
    await expect(page.locator(PILL)).toHaveCount(0);
  });
});
