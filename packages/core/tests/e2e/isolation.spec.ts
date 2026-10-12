/**
 * Isolation in both directions on the real shell, over the adversarial theme.
 *
 * The chrome lives in a shadow root of the shell's own document and the site
 * lives in the framed document, so neither can style or reach the other. These
 * checks prove it by measurement: the chrome is identical whether the site
 * behind it is hostile or clean, the site inside the frame is identical to the
 * same page opened on its own at the frame's size, the site's interactive
 * components keep working under the chrome, and the CMS adds nothing to the
 * site's document.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { assertSiteBehaviour } from './helpers/site-behaviour.ts';
import { boxSnapshot, styleSnapshot } from './helpers/snapshots.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const FRAME = `${HOST} iframe`;

/** The chrome elements measured, as selectors inside the shadow root. */
const CHROME_SAMPLE = [
  'aside',
  '[data-sidebar]',
  '[data-sidebar] > a',
  '[data-sidebar] > div:first-of-type',
  '[data-sidebar] [data-slot="nav"]',
  '[data-sidebar] button',
  '[data-sidebar] > div:last-of-type > a',
  '[data-sidebar] p',
  '[data-sidebar] form',
  '[data-sidebar] form button',
  '[data-rail]',
  '[role="region"]',
  'iframe',
] as const;

/** The site elements measured inside the frame, one per hostile pattern. */
const SITE_SAMPLE = [
  'html',
  'body',
  'header.site-header',
  '.variant-plain h2',
  '.variant-transform h2',
  '.variant-filter h2',
  '.variant-contain h2',
  '.variant-isolation h2',
  '[data-carousel-track]',
  '.cookie-banner',
  '.badge',
  '#site-footer',
] as const;

type ChromeRecord = Record<
  string,
  {
    styles: Record<string, string>;
    box: [number, number, number, number];
  } | null
>;

/** Every computed style and the box of each sampled chrome element, read
 * through the shadow root. */
async function chromeSnapshot(page: Page): Promise<ChromeRecord> {
  return await page.evaluate(
    ({ host, selectors }) => {
      const root = document.querySelector(host)?.shadowRoot;
      const record: ChromeRecord = {};
      for (const selector of selectors) {
        const element = root?.querySelector(selector) ?? null;
        if (element === null) {
          record[selector] = null;
          continue;
        }
        const computed = getComputedStyle(element);
        const styles: Record<string, string> = {};
        for (const name of computed) {
          styles[name] = computed.getPropertyValue(name);
        }
        const { x, y, width, height } = element.getBoundingClientRect();
        record[selector] = { styles, box: [x, y, width, height] };
      }
      return record;
    },
    { host: HOST, selectors: CHROME_SAMPLE },
  );
}

async function openShell(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
  // the framed site has loaded and its own scripts have run
  const frame = await framedSite(page);
  await frame.waitForFunction(
    () =>
      document.readyState === 'complete' ||
      (window as Window & { __siteScriptsReady?: boolean })
        .__siteScriptsReady === true,
  );
}

async function framedSite(page: Page): Promise<Frame> {
  const handle = await page.locator(FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) {
    throw new Error('The shell has no framed document');
  }
  return frame;
}

/** The names of every computed property the engine reports. */
async function allProperties(target: Page | Frame): Promise<string[]> {
  return await target.evaluate(() => [
    ...getComputedStyle(document.documentElement),
  ]);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('the chrome is not changed by the site behind it', () => {
  test('has identical computed styles and boxes over the adversarial theme and the clean theme', async ({
    page,
  }) => {
    await openShell(page, '/clean?_edit=1');
    const clean = await chromeSnapshot(page);
    const cleanFrame = await framedSite(page);
    // the clean baseline really is clean, and the hostile page really is not
    expect(
      await cleanFrame.evaluate(
        () => getComputedStyle(document.documentElement).fontSize,
      ),
    ).not.toBe('10px');

    await openShell(page, '/?_edit=1');
    const hostile = await chromeSnapshot(page);
    const hostileFrame = await framedSite(page);
    expect(
      await hostileFrame.evaluate(
        () => getComputedStyle(document.documentElement).fontSize,
      ),
    ).toBe('10px');

    for (const selector of CHROME_SAMPLE) {
      expect(clean[selector], `${selector} is in the chrome`).not.toBeNull();
    }
    expect(hostile).toEqual(clean);
  });

  test('keeps its own sizes in px, whatever the site does to html font-size', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const chrome = await chromeSnapshot(page);
    expect(chrome['[data-sidebar] button']?.styles['font-size']).toBe('14px');
    expect(chrome['[data-sidebar] button']?.styles['height']).toBe('40px');
    expect(chrome['[data-sidebar] p']?.styles['font-size']).toBe('14px');
    expect(chrome['aside']?.styles['font-family']).toContain('sans-serif');

    // The snapshot is sensitive: the same elements measure differently in the
    // rail, so an unchanged comparison above is not an empty one.
    await page.locator(`${HOST} [data-sidebar] button[aria-pressed]`).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    const rail = await chromeSnapshot(page);
    expect(chrome['aside']?.box[2]).toBe(280);
    expect(rail['aside']?.box[2]).toBe(56);
    expect(rail).not.toEqual(chrome);
  });
});

test.describe('the site is not changed by the chrome around it', () => {
  test('has the computed styles and boxes it has on its own page at the same size', async ({
    page,
    context,
  }) => {
    await openShell(page, '/?_edit=1');
    const framed = await framedSite(page);
    const size = await framed.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const properties = await allProperties(framed);
    expect(properties.length).toBeGreaterThan(100);
    const inFrame = {
      styles: await styleSnapshot(framed, SITE_SAMPLE, properties),
      boxes: await boxSnapshot(framed, SITE_SAMPLE),
    };

    const standalone = await context.newPage();
    await standalone.setViewportSize(size);
    const response = await standalone.goto('/');
    expect(response?.status()).toBe(200);
    await standalone.waitForFunction(
      () =>
        (window as Window & { __siteScriptsReady?: boolean })
          .__siteScriptsReady === true,
    );
    const alone = {
      styles: await styleSnapshot(standalone, SITE_SAMPLE, properties),
      boxes: await boxSnapshot(standalone, SITE_SAMPLE),
    };
    // the sample must exist on both pages, or an empty comparison proves
    // nothing
    for (const selector of SITE_SAMPLE) {
      expect(
        alone.boxes[selector],
        `${selector} on its own page`,
      ).not.toBeNull();
    }
    // the only difference is the analytics flag, which is not a style
    expect(
      await standalone.evaluate(
        () =>
          (window as Window & { __analyticsFired?: boolean }).__analyticsFired,
      ),
    ).toBe(true);
    expect(
      await framed.evaluate(
        () =>
          (window as Window & { __analyticsFired?: boolean }).__analyticsFired,
      ),
    ).toBeUndefined();

    expect(inFrame.styles).toEqual(alone.styles);
    expect(inFrame.boxes).toEqual(alone.boxes);

    // The comparison is sensitive: the same page at another size measures
    // differently, so the equality above is not an empty one.
    await standalone.setViewportSize({
      width: size.width - 200,
      height: size.height,
    });
    const narrower = await boxSnapshot(standalone, SITE_SAMPLE);
    expect(narrower).not.toEqual(alone.boxes);
    await standalone.close();
  });

  test("keeps the site's accordion, carousel, sticky header, scroll listener, fixed banner and dialog working under the chrome", async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    await assertSiteBehaviour(await framedSite(page));
    // the window around the frame never moved
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(
        () =>
          (document.scrollingElement?.scrollHeight ?? 0) <= window.innerHeight,
      ),
    ).toBe(true);
  });

  test('keeps working in the full-width layout too', async ({ page }) => {
    await openShell(page, '/?_edit=1');
    await page.locator(`${HOST} [data-sidebar] button[aria-pressed]`).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await assertSiteBehaviour(await framedSite(page));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('the editor adds nothing to the site document', () => {
  test('holds no chrome, popover, extra stylesheet or script, and the hostile rules aimed at injected elements match nothing', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const framed = await framedSite(page);
    const facts = await framed.evaluate(() => {
      const outlined = [...document.querySelectorAll('*')].filter((element) => {
        const { outlineColor, outlineWidth, outlineStyle } =
          getComputedStyle(element);
        return (
          outlineStyle !== 'none' &&
          outlineWidth === '5px' &&
          outlineColor === 'rgb(255, 0, 0)'
        );
      }).length;
      const bodyChildren = [...document.body.children].map(
        (element) => element.localName,
      );
      return {
        chrome: document.querySelectorAll('plakboek-editor, plakboek-toolbar')
          .length,
        popovers: document.querySelectorAll('[popover]').length,
        iframes: document.querySelectorAll('iframe').length,
        stylesheets: [
          ...document.querySelectorAll('link[rel~="stylesheet"]'),
        ].map((link) => link.getAttribute('href')),
        styleElements: document.querySelectorAll('style').length,
        adopted: document.adoptedStyleSheets.length,
        scripts: [...document.scripts].map(
          (script) => script.getAttribute('src') ?? '(inline)',
        ),
        bodyChildren,
        lastChildIsDialog:
          document.body.lastElementChild?.localName === 'dialog',
        outlined,
        inlineStyles: document.querySelectorAll('[style]').length,
      };
    });

    expect(facts.chrome).toBe(0);
    expect(facts.popovers).toBe(0);
    expect(facts.iframes).toBe(0);
    expect(facts.stylesheets).toEqual(['/theme.css']);
    expect(facts.styleElements).toBe(0);
    expect(facts.adopted).toBe(0);
    expect(facts.scripts).toEqual(['/site.js']);
    expect(facts.bodyChildren).toEqual([
      'header',
      'main',
      'footer',
      'div',
      'dialog',
    ]);
    expect(facts.lastChildIsDialog).toBe(true);
    expect(facts.outlined).toBe(0);
    // the one inline style on the page is the host's own spacer block
    expect(facts.inlineStyles).toBe(1);
  });
});

test.describe('chrome utilities compute inside the shadow root', () => {
  test('gives a focused sidebar button a 2px solid outline with a 2px offset, and the frame its shadow', async ({
    page,
    browserName,
  }) => {
    await openShell(page, '/?_edit=1');

    // Tab to the Full width button (Safari skips links unless Option is held).
    const press = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const focused = async () =>
      await page.evaluate((host) => {
        const active = document.querySelector(host)?.shadowRoot?.activeElement;
        return active?.getAttribute('aria-pressed') !== null
          ? active?.localName
          : null;
      }, HOST);
    for (let step = 0; step < 4 && (await focused()) !== 'button'; step += 1) {
      await page.keyboard.press(press);
    }
    expect(await focused()).toBe('button');

    const outline = await page.evaluate((host) => {
      const active = document.querySelector(host)?.shadowRoot?.activeElement;
      if (active === null || active === undefined) return null;
      const computed = getComputedStyle(active);
      return {
        style: computed.outlineStyle,
        width: computed.outlineWidth,
        offset: computed.outlineOffset,
        color: computed.outlineColor,
      };
    }, HOST);
    expect(outline).toEqual({
      style: 'solid',
      width: '2px',
      offset: '2px',
      color: 'rgb(79, 70, 229)',
    });

    const shadow = await page
      .locator(FRAME)
      .evaluate((element) => getComputedStyle(element).boxShadow);
    expect(shadow).not.toBe('none');
    expect(shadow).toContain('24px');
  });
});
