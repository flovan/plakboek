/**
 * The hot block swap on the dev server (D-29). Editing a host block component
 * on disk replaces only the changed blocks on a visitor page and in the edit
 * frame, without reloading either, while a change to the config or the site
 * document still reloads. Every file a case edits is restored and the restore
 * is asserted.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startDevServer, type DevServer } from './helpers/dev-server.ts';
import { E2E_HOST_DIR } from './helpers/host.ts';

const BLOCKS_FILE = join(E2E_HOST_DIR, 'blocks.tsx');

const TEXT_COMPONENT = `className="reset-target">
    {props.text}
  </p>`;

/** Runs `body` with `file` changed by `change`, then restores and checks it. */
async function withEdited(
  file: string,
  change: (source: string) => string,
  body: () => Promise<void>,
): Promise<void> {
  const original = await readFile(file, 'utf8');
  const changed = change(original);
  expect(changed).not.toBe(original);
  try {
    await writeFile(file, changed);
    await body();
  } finally {
    await writeFile(file, original);
    expect(await readFile(file, 'utf8')).toBe(original);
  }
}

/** Tags the nodes a no-reload swap must keep or replace. */
async function tagVisitorNodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sections = document.querySelectorAll('section[data-pk-block]');
    Reflect.set(window, '__marker', 1);
    Reflect.set(sections[1] ?? {}, '__node', 'section');
    Reflect.set(document.querySelector('h2') ?? {}, '__node', 'heading');
    Reflect.set(document.querySelector('p.reset-target') ?? {}, '__node', 'p');
  });
}

test.describe('the hot block swap on the dev server', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'the dev server is exercised in one engine',
  );
  test.setTimeout(180_000);

  let server: DevServer | undefined;

  test.beforeAll(async () => {
    server = await startDevServer();
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  function origin(): string {
    if (server === undefined) throw new Error('The dev server did not start');
    return server.baseURL;
  }

  test('a visitor page swaps only the changed blocks, with no reload', async ({
    page,
  }) => {
    await page.goto(`${origin()}/`);
    await expect(page.locator('p.reset-target').first()).toBeVisible();
    await tagVisitorNodes(page);

    await withEdited(
      BLOCKS_FILE,
      (source) =>
        source.replace(
          TEXT_COMPONENT,
          `className="reset-target swapped">
    {props.text} (swapped)
  </p>`,
        ),
      async () => {
        await expect(
          page.locator('p.reset-target.swapped').first(),
        ).toContainText('(swapped)', { timeout: 20_000 });
        const kept = await page.evaluate(() => ({
          marker: Reflect.get(window, '__marker'),
          section: Reflect.get(
            document.querySelectorAll('section[data-pk-block]')[1] ?? {},
            '__node',
          ),
          heading: Reflect.get(document.querySelector('h2') ?? {}, '__node'),
          paragraph: Reflect.get(
            document.querySelector('p.reset-target') ?? {},
            '__node',
          ),
        }));
        expect(kept.marker).toBe(1);
        expect(kept.section).toBe('section');
        expect(kept.heading).toBe('heading');
        // The changed block is a new node, so it lost its tag.
        expect(kept.paragraph).toBeUndefined();
      },
    );
  });
});
