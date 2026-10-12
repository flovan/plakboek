/**
 * The edit shell on a production build: an editor signs in
 * and opens `<page>?_edit=1`, the shell paints, the editor's own chunk loads
 * and hydrates it, and the same-origin iframe shows the live working tree.
 * Anonymous visitors get no editor at all.
 */
import { expect, test, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const FRAME = `${HOST} iframe`;

// The viewport is 1400x900: a 280px sidebar, then 24px of stage padding on
// the left, top, right and bottom of the frame.
const EXPECTED_FRAME_BOX = { x: 304, y: 24, width: 1072, height: 852 };
const GEOMETRY_TOLERANCE = 1;

/** Console and page errors a hydration problem would leave behind. */
function watchForHydrationProblems(page: Page): readonly string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      /hydrat|Minified React error|did not match/i.test(text)
    ) {
      problems.push(text);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  return problems;
}

/** The URLs of every request for the framed document. */
function watchFrameRequests(page: Page): readonly string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).searchParams.get('_edit') === 'frame') {
      urls.push(request.url());
    }
  });
  return urls;
}

test.describe('an editor in edit mode', () => {
  test('gets the shell, hydrates it from its own chunk and sees the live working tree in the frame', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().editor);
    const problems = watchForHydrationProblems(page);
    const frameRequests = watchFrameRequests(page);
    const chunk = page.waitForResponse((response) =>
      /\/assets\/plakboek-editor-[\w-]+\.js$/.test(
        new URL(response.url()).pathname,
      ),
    );

    const response = await page.goto('/about?_edit=1');
    expect(response?.status()).toBe(200);

    // The shell paints from the server's markup: an open shadow root with the
    // sidebar and one iframe on the frame URL.
    expect(
      await page.evaluate(
        (tag) => document.querySelector(tag)?.shadowRoot?.mode,
        HOST,
      ),
    ).toBe('open');
    const frame = page.locator(FRAME);
    await expect(frame).toHaveAttribute('src', /_edit=frame$/);

    // The editor's chunk loads and hydrates the shell.
    expect((await chunk).status()).toBe(200);
    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(
      page.getByRole('button', { name: 'Full width' }),
    ).toBeEnabled();

    // The framed document is the live working tree, with its block attributes.
    const framed = page.frameLocator(FRAME);
    await expect(
      framed.getByRole('heading', { name: 'Unpublished change' }),
    ).toBeVisible();
    expect(await framed.locator('[data-pk-block]').count()).toBeGreaterThan(0);

    // Framed at 1:1 inside the stage.
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(
        Math.abs((box?.[key] ?? Number.NaN) - EXPECTED_FRAME_BOX[key]),
      ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    }

    // Hydrating neither warns nor reloads the frame.
    expect(problems).toEqual([]);
    expect(frameRequests).toHaveLength(1);
  });

  test('frames a page that only exists as a draft', async ({ page }) => {
    await signIn(page, e2eUsers().editor);
    const response = await page.goto('/draft-only?_edit=1');
    expect(response?.status()).toBe(200);

    const framed = page.frameLocator(FRAME);
    await expect(
      framed.getByRole('heading', { name: 'Draft only' }),
    ).toBeVisible();
    expect(await framed.locator('[data-pk-block]').count()).toBeGreaterThan(0);
  });
});

test.describe('a user who cannot edit', () => {
  test('gets the shell read-only, with the published page and no editing attributes', async ({
    page,
  }) => {
    await signIn(page, e2eUsers().viewer);
    const response = await page.goto('/about?_edit=1');
    expect(response?.status()).toBe(200);

    await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
    await expect(page.locator(`${HOST} [role="note"]`)).toContainText(
      'can view this site but not edit',
    );

    const framed = page.frameLocator(FRAME);
    await expect(
      framed.getByRole('heading', { name: 'About us' }),
    ).toBeVisible();
    await expect(
      framed.getByRole('heading', { name: 'Unpublished change' }),
    ).toHaveCount(0);
    expect(await framed.locator('[data-pk-block]').count()).toBe(0);
  });
});

test.describe('an anonymous visitor', () => {
  test('is bounced from ?_edit=1 to the plain page', async ({ page }) => {
    await page.goto('/about?_edit=1');
    const url = new URL(page.url());
    expect(url.pathname).toBe('/about');
    expect(url.search).toBe('');
    await expect(page.locator(HOST)).toHaveCount(0);
  });

  test('gets a page with no reference to the editor', async ({ page }) => {
    const response = await page.request.get('/about');
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(HOST);
    expect(body).not.toContain('/assets/plakboek-editor-');
  });
});
