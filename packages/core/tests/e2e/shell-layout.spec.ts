/**
 * The edit shell's two layouts on a production build: the
 * framed default (280px sidebar, the page 24px from the edges), the 56px rail
 * with the page flush, the choice kept per browser and applied before first
 * paint, the rail's keyboard and tooltip behaviour, and keyboard focus
 * following the layout toggle into the layer now shown.
 */
import { expect, test, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const FRAME = `${HOST} iframe`;
const SIDEBAR = `${HOST} aside`;
const RAIL = `${HOST} [data-rail]`;
const SIDEBAR_BODY = `${HOST} [data-sidebar]`;
// Both layers are always in the markup; the host's layout decides which one is
// seen. While the 240ms swap runs both are briefly visible, so each toggle is
// addressed through its own layer.
const FRAMED_TOGGLE = `${SIDEBAR_BODY} button[aria-pressed]`;
const RAIL_TOGGLE = `${RAIL} button[aria-pressed]`;
const STORAGE_KEY = 'plakboek:editor-layout';

// The viewport is 1400x900.
const FRAMED_FRAME = { x: 304, y: 24, width: 1072, height: 852 };
const FULL_FRAME = { x: 56, y: 0, width: 1344, height: 900 };
const TOLERANCE = 1;

type Box = { x: number; y: number; width: number; height: number };

function expectBox(actual: Box | null, expected: Box): void {
  expect(actual).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs((actual?.[key] ?? Number.NaN) - expected[key]),
      `${key} of ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`,
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

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
  test('is the default: 280px sidebar and the page 24px from the stage edges', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');

    expectBox(await page.locator(FRAME).boundingBox(), FRAMED_FRAME);
    const sidebar = await page.locator(SIDEBAR).boundingBox();
    expect(Math.abs((sidebar?.width ?? 0) - 280)).toBeLessThanOrEqual(
      TOLERANCE,
    );
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
  test('switches to a 56px rail with the page flush, and back', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');

    await page.locator(FRAMED_TOGGLE).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await expect(page.locator(RAIL_TOGGLE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expectBox(await page.locator(FRAME).boundingBox(), FULL_FRAME);
    const rail = await page.locator(SIDEBAR).boundingBox();
    expect(Math.abs((rail?.width ?? 0) - 56)).toBeLessThanOrEqual(TOLERANCE);

    await page.locator(RAIL_TOGGLE).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    expectBox(await page.locator(FRAME).boundingBox(), FRAMED_FRAME);
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
    expectBox(await page.locator(FRAME).boundingBox(), FULL_FRAME);
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
    expectBox(await page.locator(FRAME).boundingBox(), FULL_FRAME);
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
    expectBox(await page.locator(FRAME).boundingBox(), FRAMED_FRAME);
  });
});

// Browsers drop focus from a control once its layer finishes hiding, so a stale
// focus only fails the check made after the swap; the check at once covers the
// move itself. Both run, with and without the transition.
test.describe('keyboard focus through the layout toggle', () => {
  const motions = ['no-preference', 'reduce'] as const;
  for (const motion of motions) {
    test(`moves to the toggle of the layout now shown, both ways (${motion} motion)`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await openShell(page, '/about?_edit=1');

      await page.locator(FRAMED_TOGGLE).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
      await expect(page.locator(RAIL_TOGGLE)).toBeFocused();
      await expect(page.locator(SIDEBAR_BODY)).toHaveCSS(
        'visibility',
        'hidden',
      );
      await expect(page.locator(RAIL_TOGGLE)).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
      await expect(page.locator(FRAMED_TOGGLE)).toBeFocused();
      await expect(page.locator(RAIL)).toHaveCSS('visibility', 'hidden');
      await expect(page.locator(FRAMED_TOGGLE)).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    });
  }
});

test.describe('the rail', () => {
  test('shows a tooltip when a button takes keyboard focus', async ({
    page,
    browserName,
  }) => {
    await signIn(page, e2eUsers().editor);
    await page.addInitScript((key) => {
      localStorage.setItem(key, 'full');
    }, STORAGE_KEY);
    await page.goto('/about?_edit=1');
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');

    const tooltip = page.locator(`${RAIL} [data-tooltip]`, {
      hasText: 'Exit edit mode',
    });
    await expect(tooltip).toHaveCSS('visibility', 'hidden');

    // skip link, Full width, Exit edit mode
    for (let step = 0; step < 3; step += 1) await tab(page, browserName);
    expect(
      await page.evaluate(
        (tag) =>
          document
            .querySelector(tag)
            ?.shadowRoot?.activeElement?.getAttribute('aria-label'),
        HOST,
      ),
    ).toBe('Exit edit mode');
    await expect(tooltip).toHaveCSS('visibility', 'visible');
    await expect(tooltip).toHaveCSS('opacity', '1');
    await expect(tooltip).toBeVisible();

    // The tooltip sits to the right of its button with an 8px gap.
    const anchor = await page
      .locator(`${RAIL} a[aria-label="Exit edit mode"]`)
      .boundingBox();
    const shown = await tooltip.boundingBox();
    expect(
      Math.abs((shown?.x ?? 0) - ((anchor?.x ?? 0) + (anchor?.width ?? 0) + 8)),
    ).toBeLessThanOrEqual(TOLERANCE);
  });

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

  test('swaps instantly under reduced motion and over 240ms otherwise', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');
    const duration = (selector: string) =>
      page
        .locator(selector)
        .evaluate((element) => getComputedStyle(element).transitionDuration);

    await expect.poll(() => duration(RAIL)).toBe('0.24s');
    await expect.poll(() => duration(`${HOST} [data-sidebar]`)).toBe('0.24s');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => duration(RAIL)).toBe('0s');
    await page.locator(FRAMED_TOGGLE).click();
    // No transition: the very next style computation already shows the rail.
    expect(
      await page
        .locator(RAIL)
        .evaluate((element) => getComputedStyle(element).opacity),
    ).toBe('1');
    expect(
      await page
        .locator(`${HOST} [data-sidebar]`)
        .evaluate((element) => getComputedStyle(element).opacity),
    ).toBe('0');
  });
});
