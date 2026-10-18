import { expect, test, type Page } from '@playwright/test';

const EDITOR_FLAG = 'plakboek:editor';
const TOOLBAR = 'plakboek-toolbar';

/** Marks this browser as one an editor signed in on, before any script runs. */
async function flagEditor(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, '1');
  }, EDITOR_FLAG);
}

/** Facts about what the CMS added to a visitor page. */
async function describePage(page: Page) {
  return await page.evaluate((tag) => {
    const inlineScripts = [...document.scripts].filter(
      (script) => script.src === '',
    ).length;
    return {
      toolbars: document.querySelectorAll(tag).length,
      bodyChildren: document.body.children.length,
      inlineScripts,
      cmsLinks: document.querySelectorAll('a[href^="/cms"]').length,
      forms: document.querySelectorAll('form').length,
    };
  }, TOOLBAR);
}

/**
 * Clicks the Edit button. The pill lives in a closed shadow root, which no
 * locator can reach, so this clicks where the button is: the pill is fixed
 * 16px from the bottom-right corner, with the dismiss button last, so Edit
 * sits just left of it. The hit test proves the click lands on the pill.
 */
async function clickEdit(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('the page has no viewport');
  const x = viewport.width - 76;
  const y = viewport.height - 33;
  const hit = await page.evaluate(
    ([px, py]) => document.elementFromPoint(px ?? 0, py ?? 0)?.localName,
    [x, y],
  );
  expect(hit).toBe(TOOLBAR);
  await page.mouse.click(x, y);
}

test.describe('the Edit pill on a visitor page', () => {
  test('a visitor without the editor flag sees no pill and no login entry point', async ({
    page,
  }) => {
    const response = await page.goto('/about');
    expect(response?.status()).toBe(200);
    const facts = await describePage(page);
    expect(facts.toolbars).toBe(0);
    expect(facts.cmsLinks).toBe(0);
    expect(facts.forms).toBe(0);
    // The bootstrap is the one inline script the CMS adds.
    expect(facts.inlineScripts).toBe(1);
  });

  test('with the flag the pill is the only thing the CMS adds', async ({
    page,
  }) => {
    await page.goto('/about');
    const before = await describePage(page);

    await flagEditor(page);
    await page.goto('/about');
    await expect.poll(async () => (await describePage(page)).toolbars).toBe(1);
    const after = await describePage(page);

    expect(after.bodyChildren).toBe(before.bodyChildren + 1);
    expect(after.inlineScripts).toBe(before.inlineScripts);
    expect(after.cmsLinks).toBe(0);
    expect(after.forms).toBe(0);
  });

  test('clicking Edit lands on /cms with the current page as next', async ({
    page,
  }) => {
    await flagEditor(page);
    await page.goto('/about');
    await expect.poll(async () => (await describePage(page)).toolbars).toBe(1);

    await clickEdit(page);
    // The /cms route arrives in a later plan: only the target matters here.
    await page.waitForURL((url) => url.pathname === '/cms');
    const url = new URL(page.url());
    expect(url.pathname).toBe('/cms');
    expect(url.searchParams.get('next')).toBe('/about');
    expect(url.searchParams.has('_edit')).toBe(false);
  });

  test('the next value keeps the query and drops _edit', async ({ page }) => {
    await flagEditor(page);
    await page.goto('/about?utm=x');
    await expect.poll(async () => (await describePage(page)).toolbars).toBe(1);
    await clickEdit(page);
    await page.waitForURL((url) => url.pathname === '/cms');
    expect(new URL(page.url()).searchParams.get('next')).toBe('/about?utm=x');
  });

  test('the pill never renders inside a frame', async ({ page }) => {
    await flagEditor(page);
    await page.goto('/clean');
    // Positive control: the top window does get the pill.
    await expect.poll(async () => (await describePage(page)).toolbars).toBe(1);

    await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.src = '/about';
      frame.id = 'visitor-frame';
      const loaded = new Promise<void>((resolve) => {
        frame.addEventListener('load', () => {
          resolve();
        });
      });
      document.body.appendChild(frame);
      await loaded;
    });

    const framed = page.frames().find((frame) => frame !== page.mainFrame());
    expect(framed).toBeDefined();
    await framed?.waitForLoadState('load');
    // The flag is set for the frame too, and its bootstrap has run by now.
    expect(
      await framed?.evaluate(
        (key) => window.localStorage.getItem(key),
        EDITOR_FLAG,
      ),
    ).toBe('1');
    expect(
      await framed?.evaluate(
        (tag) => document.querySelectorAll(tag).length,
        TOOLBAR,
      ),
    ).toBe(0);
  });
});

test.describe('a production visitor response', () => {
  test('carries no block marker and no dev script', async ({ request }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('<h2');
    expect(html).not.toContain('data-pk-');
    expect(html).not.toContain('@vite/client');
    expect(html).not.toContain('virtual:plakboek/dev-swap');
  });
});
