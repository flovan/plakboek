/**
 * The edit page on the dev server: an editor signs in and `/?_edit=1` shows
 * the shell with the framed site, loading React Router's refresh preamble and
 * a data-router stub before the editor entry. Development sends no
 * Content-Security-Policy, and anonymous visitors still get no editor.
 */
import { expect, test } from '@playwright/test';
import { startDevServer, type DevServer } from './helpers/dev-server.ts';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

test.describe('the edit page on the dev server', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'the dev server is exercised in one engine',
  );
  test.setTimeout(120_000);

  let server: DevServer | undefined;

  test.beforeAll(async () => {
    server = await startDevServer();
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('shows the shell and the framed site, with the dev scripts before the editor entry', async ({
    page,
  }) => {
    if (server === undefined) throw new Error('The dev server did not start');
    const { baseURL } = server;
    await signIn(page, e2eUsers().editor, baseURL);

    const response = await page.goto(`${baseURL}/?_edit=1`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toBeUndefined();

    await expect(page.locator('plakboek-editor')).toHaveAttribute(
      'data-hydrated',
      '',
    );
    const framed = page.frameLocator('plakboek-editor iframe');
    await expect(framed.locator('[data-pk-block]').first()).toBeAttached();

    // The scripts of the shell document, in document order.
    const scripts = await page.evaluate(() =>
      [...document.scripts].map((script) => ({
        src: script.getAttribute('src'),
        code: script.src === '' ? script.textContent : null,
      })),
    );
    const at = (match: (script: (typeof scripts)[number]) => boolean) =>
      scripts.findIndex(match);
    const preamble = at((s) => s.code?.includes('inject-hmr-runtime') ?? false);
    const stub = at(
      (s) => s.code?.includes('__reactRouterDataRouter') ?? false,
    );
    const entry = at(
      (s) => s.src?.includes('virtual:plakboek/editor-client') ?? false,
    );
    // The dev server also adds Vite's client to the head of every HTML
    // response; a module loads once, so what matters is the order of the
    // preamble, the stub and the entry, and that the client is present.
    const clients = scripts.filter((s) => s.src?.endsWith('/@vite/client'));
    expect(preamble).toBeGreaterThanOrEqual(0);
    expect(stub).toBeGreaterThan(preamble);
    expect(entry).toBeGreaterThan(stub);
    expect(clients.length).toBeGreaterThan(0);
  });

  test('gives an anonymous visitor a page with no editor reference', async ({
    request,
  }) => {
    if (server === undefined) throw new Error('The dev server did not start');
    const response = await request.get(`${server.baseURL}/about`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('plakboek-editor');
    expect(html).not.toContain('virtual:plakboek/editor-client');
  });
});
