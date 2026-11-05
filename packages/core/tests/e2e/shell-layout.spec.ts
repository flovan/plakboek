/**
 * The edit shell's two layouts on a production build: the framed default and
 * the full-width rail, the choice kept per browser and applied before first
 * paint, the rail's accessible names, and keyboard focus following the layout
 * toggle into the layer now shown.
 */
import { expect, test, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const FRAME = `${HOST} iframe`;
const RAIL = `${HOST} [data-rail]`;
const SIDEBAR_BODY = `${HOST} [data-sidebar]`;
// Both layers are always in the markup; the host's layout decides which one is
// seen, so each toggle is addressed through its own layer.
const FRAMED_TOGGLE = `${SIDEBAR_BODY} button[aria-pressed]`;
const RAIL_TOGGLE = `${RAIL} [data-layout-toggle]`;
const STORAGE_KEY = 'plakboek:editor-layout';

const TOLERANCE = 1;

/** The editor host's open shadow root, evaluated in the page. */
async function activeInShadow(page: Page): Promise<{
  text: string;
  id: string;
}> {
  return await page.evaluate((tag) => {
    const active = document.querySelector(tag)?.shadowRoot?.activeElement;
    return { text: active?.textContent ?? '', id: active?.id ?? '' };
  }, HOST);
}

/** Moves focus forward. Safari (and so WebKit) leaves links out of the plain
 * Tab order unless Option is held; the other engines include them. */
async function tab(page: Page, browserName: string): Promise<void> {
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
}

async function openShell(page: Page, path: string): Promise<void> {
  await signIn(page, e2eUsers().editor);
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
}

async function frameWindow(page: Page) {
  const handle = await page.locator(FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) {
    throw new Error('The shell has no framed document');
  }
  return frame;
}

test.describe('the framed layout', () => {
  test('is the default', async ({ page }) => {
    await openShell(page, '/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    await expect(
      page.getByRole('button', { name: 'Full width' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('puts the skip link first in the tab order and moves focus to the page region', async ({
    page,
    browserName,
  }) => {
    await openShell(page, '/about?_edit=1');

    await tab(page, browserName);
    expect((await activeInShadow(page)).text).toBe('Skip to page');

    await page.keyboard.press('Enter');
    expect((await activeInShadow(page)).id).toBe('plakboek-stage');
  });
});

test.describe('the full-width layout', () => {
  test('switches to the rail, and back', async ({ page }) => {
    await openShell(page, '/about?_edit=1');

    await page.locator(FRAMED_TOGGLE).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await expect(page.locator(RAIL_TOGGLE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.locator(RAIL_TOGGLE).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    await expect(page.locator(FRAMED_TOGGLE)).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test("keeps the frame's own scroll position through the toggle, and the top window never scrolls", async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await frameWindow(page);
    await frame.waitForFunction(() => document.readyState === 'complete');
    await frame.evaluate(() =>
      window.scrollTo({ top: 600, behavior: 'instant' }),
    );
    expect(Math.abs((await frame.evaluate(() => window.scrollY)) - 600)).toBe(
      0,
    );

    for (let round = 0; round < 2; round += 1) {
      await page.locator(FRAMED_TOGGLE).click();
      await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
      await page.locator(RAIL_TOGGLE).click();
      await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    }

    await expect
      .poll(async () =>
        Math.abs((await frame.evaluate(() => window.scrollY)) - 600),
      )
      .toBeLessThanOrEqual(TOLERANCE);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(
        () =>
          (document.scrollingElement?.scrollHeight ?? 0) <= window.innerHeight,
      ),
    ).toBe(true);
  });

  test('is remembered per browser: a reload stays full width', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');
    await page.locator(FRAMED_TOGGLE).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    expect(
      await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
    ).toBe('full');

    await page.reload();
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await expect(page.locator(RAIL_TOGGLE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Back to framed is remembered as well.
    await page.locator(RAIL_TOGGLE).click();
    await page.reload();
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
  });

  test('is applied before first paint by the inline script, without the editor chunk', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.addInitScript((key) => {
      localStorage.setItem(key, 'full');
    }, STORAGE_KEY);
    await page.route('**/assets/plakboek-editor-*', (route) => route.abort());

    const response = await page.goto('/about?_edit=1');
    expect(response?.status()).toBe(200);

    // Nothing but the pre-paint script can have set it: no editor code ran.
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-hydrated', '');
    await expect(page.locator(RAIL_TOGGLE)).toBeDisabled();
    // Exit and Log out are the real anchor and form of the server markup.
    await expect(
      page.locator(`${RAIL} a[aria-label="Exit edit mode"]`),
    ).toHaveAttribute('href', '/about');
    await expect(
      page.locator(`${RAIL} form[action="/cms/logout"] button`),
    ).toBeEnabled();
  });

  test('ignores a stored value that is not exactly full', async ({ page }) => {
    await signIn(page, e2eUsers().editor);
    await page.addInitScript((key) => {
      localStorage.setItem(key, 'FULL');
    }, STORAGE_KEY);
    await page.route('**/assets/plakboek-editor-*', (route) => route.abort());
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
  });
});

// Browsers drop focus from a control once its layer finishes hiding, so a stale
// focus only fails the check made after the swap; the check at once covers the
// move itself.
test.describe('keyboard focus through the layout toggle', () => {
  test('moves to the toggle of the layout now shown, both ways', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');

    await page.locator(FRAMED_TOGGLE).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await expect(page.locator(RAIL_TOGGLE)).toBeFocused();
    await expect(page.locator(SIDEBAR_BODY)).toBeHidden();
    await expect(page.locator(RAIL_TOGGLE)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    await expect(page.locator(FRAMED_TOGGLE)).toBeFocused();
    await expect(page.locator(RAIL)).toBeHidden();
    await expect(page.locator(FRAMED_TOGGLE)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
  });
});

test.describe('the rail', () => {
  test('names the avatar and every icon button by the full label or name', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.addInitScript((key) => {
      localStorage.setItem(key, 'full');
    }, STORAGE_KEY);
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    await expect(page.getByRole('img', { name: 'Edith Editor' })).toHaveText(
      'E',
    );
    for (const name of ['Full width', 'Exit edit mode', 'Log out']) {
      await expect(
        page.locator(`${RAIL} [aria-label="${name}"]`),
      ).toBeVisible();
    }
  });
});
