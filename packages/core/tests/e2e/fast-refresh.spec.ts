/**
 * React Fast Refresh on the dev server's edit page (D-29): a stateful client
 * component in the editor's client graph is edited on disk and the page shows
 * the new render with its state kept and without a navigation. The edit page
 * hydrates an entry that is not a React Router route, so this depends on two
 * React Router internals, its HMR preamble and a data router; the spec fails
 * the day either changes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startDevServer, type DevServer } from './helpers/dev-server.ts';
import { E2E_HOST_DIR, e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const PROBE_FILE = join(E2E_HOST_DIR, 'app', 'refresh-probe.tsx');

test.describe('Fast Refresh on the dev edit page', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'the dev server is exercised in one engine',
  );
  test.setTimeout(120_000);

  let server: DevServer | undefined;

  test.beforeAll(async () => {
    server = await startDevServer({ env: { E2E_REFRESH_PROBE: '1' } });
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('keeps a client component state across an edit, with no navigation', async ({
    page,
  }) => {
    if (server === undefined) throw new Error('The dev server did not start');
    const { baseURL } = server;
    const original = await readFile(PROBE_FILE, 'utf8');
    try {
      await signIn(page, e2eUsers().editor, baseURL);
      await page.goto(`${baseURL}/?_edit=1`);

      const probe = page.locator('#refresh-probe button');
      await expect(probe).toHaveText('count 0 v1');
      await probe.click({ timeout: 10_000 });
      await probe.click({ timeout: 10_000 });
      await expect(probe).toHaveText('count 2 v1');

      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });

      await writeFile(PROBE_FILE, original.replace('v1', 'v2'));
      await expect(probe).toHaveText('count 2 v2', { timeout: 10_000 });
      expect(navigations).toBe(0);
    } finally {
      await writeFile(PROBE_FILE, original);
      expect(await readFile(PROBE_FILE, 'utf8')).toBe(original);
    }
  });
});
