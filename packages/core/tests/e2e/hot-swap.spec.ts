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
import { E2E_HOST_DIR, e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const BLOCKS_FILE = join(E2E_HOST_DIR, 'blocks.tsx');
const CONFIG_FILE = join(E2E_HOST_DIR, 'plakboek.config.ts');
const SITE_FILE = join(E2E_HOST_DIR, 'app', 'site.ts');
const FRAME = 'plakboek-editor iframe';
const BADGE_COMPONENT = "<span {...edit.field('label')}>{props.label}</span>";
const ACCORDION_ROOT =
  '<div {...edit} className="accordion" data-accordion="">';

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

/** The edit shell's frame, once the editor has loaded the page in it. */
async function framedPage(page: Page, base: string) {
  await signIn(page, e2eUsers().editor, base);
  await page.goto(`${base}/?_edit=1`);
  await expect(page.locator('plakboek-editor')).toHaveAttribute(
    'data-hydrated',
    '',
  );
  const handle = await page.locator(FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) throw new Error('no frame');
  await expect(frame.locator('[data-pk-block]').first()).toBeAttached();
  return frame;
}

/** Whether `window.__marker` is gone from the page's window and its frame's. */
async function markersGone(page: Page): Promise<boolean> {
  try {
    const frame = page.frames().find((f) => f.url().includes('_edit=frame'));
    const [shell, framed] = await Promise.all([
      page.evaluate(() => Reflect.get(window, '__marker') === undefined),
      frame === undefined
        ? true
        : frame.evaluate(() => Reflect.get(window, '__marker') === undefined),
    ]);
    return shell && framed;
  } catch {
    // Mid-navigation: the old window is gone, which is what is being waited for.
    return false;
  }
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

  test('the edit frame swaps a block with the shell and scroll kept, and runs the rendered hook', async ({
    page,
  }) => {
    const frame = await framedPage(page, origin());
    await frame.evaluate(() => {
      window.scrollTo(0, 400);
      Reflect.set(window, '__marker', 1);
      Reflect.set(
        document.querySelectorAll('section[data-pk-block]')[1] ?? {},
        '__node',
        'section',
      );
    });
    await page.evaluate(() => Reflect.set(window, '__marker', 1));
    expect(await frame.evaluate(() => window.scrollY)).toBe(400);

    await withEdited(
      BLOCKS_FILE,
      (source) =>
        source.replace(
          BADGE_COMPONENT,
          "<span {...edit.field('label')}>{props.label} (hot)</span>",
        ),
      async () => {
        await expect(frame.locator('.badge span')).toContainText('(hot)', {
          timeout: 20_000,
        });
        await expect(frame.locator('.badge')).toHaveAttribute(
          'data-rendered-by-hook',
          '1',
        );
        expect(await page.evaluate(() => Reflect.get(window, '__marker'))).toBe(
          1,
        );
        expect(
          await frame.evaluate(() => Reflect.get(window, '__marker')),
        ).toBe(1);
        expect(await frame.evaluate(() => window.scrollY)).toBe(400);
        expect(
          await frame.evaluate(() =>
            Reflect.get(
              document.querySelectorAll('section[data-pk-block]')[1] ?? {},
              '__node',
            ),
          ),
        ).toBe('section');
      },
    );
  });

  test('a style change in a block shows without a reload', async ({ page }) => {
    await page.goto(`${origin()}/`);
    await expect(page.locator('.accordion').first()).toBeVisible();
    await page.evaluate(() => Reflect.set(window, '__marker', 1));
    const colour = () =>
      page
        .locator('.accordion')
        .first()
        .evaluate((element) => getComputedStyle(element).color);
    const before = await colour();

    await withEdited(
      BLOCKS_FILE,
      (source) =>
        source.replace(
          ACCORDION_ROOT,
          '<div {...edit} className="accordion" data-accordion="" style={{ color: \'rgb(12, 34, 56)\' }}>',
        ),
      async () => {
        await expect.poll(colour, { timeout: 20_000 }).toBe('rgb(12, 34, 56)');
        expect(await page.evaluate(() => Reflect.get(window, '__marker'))).toBe(
          1,
        );
      },
    );
    expect(before).not.toBe('rgb(12, 34, 56)');
  });

  for (const [name, file] of [
    ['the config', CONFIG_FILE],
    ['the site document', SITE_FILE],
  ] as const) {
    test(`a change to ${name} still reloads the edit page`, async ({
      page,
    }) => {
      const frame = await framedPage(page, origin());
      await frame.evaluate(() => Reflect.set(window, '__marker', 1));
      await page.evaluate(() => Reflect.set(window, '__marker', 1));

      await withEdited(
        file,
        (source) => `${source}\n// touched by the hot swap spec\n`,
        async () => {
          await expect
            .poll(() => markersGone(page), { timeout: 30_000 })
            .toBe(true);
        },
      );
      // The restore reloads once more; wait until the page is usable again.
      await expect(page.locator('plakboek-editor')).toBeAttached();
    });
  }
});
