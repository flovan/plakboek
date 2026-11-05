/**
 * The hover overlay on the real shell, over the adversarial theme.
 *
 * The overlay draws an outline, a dashed outline for the section around it
 * and a label chip over the block the pointer is on: the deepest item a click
 * there would select. It is
 * measured, not looked at: each outline's box is compared with the box the
 * site element has inside the frame. The overlay is drawn inside the framed
 * document (in the chrome host), so it scrolls with the page and both boxes
 * are in the same coordinate space.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  CHIP,
  chrome,
  chromeBoxOf,
  expectSelectedOver,
  framedSite,
  FRAME,
  HOST,
  OUTLINE,
  openEditor,
  SECTION_OUTLINE,
  selectItem,
  waitForShell,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const LAYER = '[data-overlay]';

type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Opens the page for editing. With `scope`, also selects that block, so blocks
 * inside its section are what the pointer hovers.
 */
async function openShell(
  page: Page,
  path: string,
  scope?: string,
): Promise<void> {
  await openEditor(page, path.replace('?_edit=1', ''));
  if (scope === undefined) return;
  const frame = await framedSite(page);
  await selectItem(page, frame.locator(scope).first());
  await expectSelectedOver(page, frame, scope);
}

/** A frame element's box in the page's coordinates. */
async function boxOf(frame: Frame, selector: string): Promise<Rect> {
  const box = await frame.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box in the frame`);
  return box;
}

/**
 * Moves the pointer to the middle of the visible part of a frame element,
 * scrolling it into view first when it is not. A tall element (the spacer)
 * is aimed at the middle of the frame, where it covers the pointer whatever
 * the frame then does.
 */
async function hover(page: Page, selector: string, along = 0.5): Promise<void> {
  const point = await page.evaluate(
    ({ host, target, fraction }) => {
      const iframe = document
        .querySelector(host)
        ?.shadowRoot?.querySelector('iframe');
      const element = iframe?.contentDocument?.querySelector(target);
      if (!iframe || !element) throw new Error(`${target} is not in the frame`);
      let rect = element.getBoundingClientRect();
      if (rect.top < 120 || rect.bottom > iframe.clientHeight - 120) {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        rect = element.getBoundingClientRect();
      }
      const frameBox = iframe.getBoundingClientRect();
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, iframe.clientHeight);
      return {
        x: frameBox.left + iframe.clientLeft + rect.left + rect.width / 2,
        y: frameBox.top + iframe.clientTop + top + (bottom - top) * fraction,
      };
    },
    { host: HOST, target: selector, fraction: along },
  );
  await page.mouse.move(point.x, point.y);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('hovering a block in the framed site', () => {
  test('outlines a heading exactly over its box and labels it above', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.variant-plain h2');
    const frame = await framedSite(page);
    const selector = '.variant-plain h2';

    await hover(page, selector);
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);
    await expectOutlineOver(page, frame, selector);

    const heading = await boxOf(frame, selector);
    const chip = chrome(page).locator(CHIP);
    await expect(chip).toHaveText('Heading');
    await expect(chip).toHaveAttribute('data-placement', 'above');
    const chipBox = await chromeBoxOf(page, CHIP);
    // the chip's bottom edge rests on the outline's top edge
    expect(
      Math.abs(chipBox.y + chipBox.height - heading.y),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(chipBox.x - heading.x)).toBeLessThanOrEqual(1);
    expect(chipBox.height).toBe(20);
  });

  test('also draws the dashed outline of the section around a block in it, without a chip of its own', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.variant-plain h2');
    await hover(page, '.variant-plain h2');
    await expect(chrome(page).locator(SECTION_OUTLINE)).toHaveCount(1);

    const dashed = await chrome(page)
      .locator(SECTION_OUTLINE)
      .evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          width: computed.borderTopWidth,
          style: computed.borderTopStyle,
          color: computed.borderTopColor,
        };
      });
    expect(dashed).toEqual({
      width: '1px',
      style: 'dashed',
      color: 'rgb(79, 70, 229)',
    });
    // one chip, and it is the block's
    await expect(chrome(page).locator(CHIP)).toHaveCount(1);
    await expect(chrome(page).locator(CHIP)).toHaveText('Heading');
  });

  test('labels a section itself with its own chip and no dashed outline', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    // the section's own top padding holds no child block, and 12px down is
    // below the band of the insert point above the first section
    const section = await boxOf(frame, 'section.variant-plain');
    await page.mouse.move(section.x + section.width / 2, section.y + 12);
    await expect(chrome(page).locator(CHIP)).toHaveText('Section');
    await expect(chrome(page).locator(SECTION_OUTLINE)).toHaveCount(0);
  });
});

test.describe('hover previews the click', () => {
  test('a hover outlines the deepest item under the pointer and the click selects that same item', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hover(page, '.variant-plain h2');
    await expect(chrome(page).locator(CHIP)).toHaveText('Heading');

    await selectItem(page, frame.locator('.variant-plain h2'));
    await expectSelectedOver(page, frame, '.variant-plain h2');
    await expect(chrome(page).locator(CHIP)).toHaveText('Heading');
  });
});

/** Waits until the hover outline belongs to the element's block. */
async function expectOutlineOver(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const element = frame.locator(selector).first();
        if ((await element.count()) === 0) return false;
        const expected = await element
          .evaluate(
            (node) =>
              node.closest('[data-pk-block]')?.getAttribute('data-pk-block') ??
              null,
            undefined,
            { timeout: 500 },
          )
          .catch(() => null);
        const target = await chrome(page)
          .locator('[data-overlay-target]')
          .first()
          .getAttribute('data-overlay-target', { timeout: 500 })
          .catch(() => null);
        return expected !== null && expected === target;
      },
      { message: `the outline is over ${selector}` },
    )
    .toBe(true);
}

/** The tall block, which keeps covering the pointer through a scroll, a
 * resize or a layout change. Hovering it leaves its top scrolled out of the
 * frame. */
async function hoverSpacer(page: Page): Promise<void> {
  await hover(page, '.spacer');
  await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);
  await expect(chrome(page).locator(CHIP)).toHaveText('Spacer');
}

/** The top of the frame's content box, in the page's coordinates. */
async function frameContentBox(page: Page): Promise<Rect> {
  return await page.locator(FRAME).evaluate((element) => {
    if (!(element instanceof HTMLIFrameElement)) throw new Error('no frame');
    const box = element.getBoundingClientRect();
    return {
      x: box.left + element.clientLeft,
      y: box.top + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight,
    };
  });
}

test.describe('over the adversarial theme', () => {
  const CASES: readonly (readonly [string, string, string])[] = [
    [
      'an element in a section under a transform',
      '.variant-transform h2',
      'Heading',
    ],
    ['an element in a section under a filter', '.variant-filter h2', 'Heading'],
    [
      'an element in a section with layout and paint containment',
      '.variant-contain h2',
      'Heading',
    ],
    [
      'an element in a section that isolates its stacking context',
      '.variant-isolation h2',
      'Heading',
    ],
    ['the fixed badge with the highest z-index there is', '.badge', 'Badge'],
  ];

  test('outlines each block under the transforms, filters, containment, isolation and fixed badge', async ({
    page,
  }) => {
    for (const [, selector, label] of CASES) {
      await openShell(page, '/?_edit=1', selector);
      const frame = await framedSite(page);
      // near the top of the element, clear of the insert point band that a
      // fixed badge can happen to sit over
      await hover(page, selector, 0.2);
      await expect(chrome(page).locator(CHIP)).toHaveText(label);
      await expectOutlineOver(page, frame, selector);
    }
  });

  test("draws the layer inside the frame document's chrome host, over the whole page", async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.spacer');
    const frame = await framedSite(page);
    await hoverSpacer(page);

    const facts = await frame.evaluate(() => {
      const host = document.querySelector('plakboek-chrome');
      const root = host?.shadowRoot;
      const layer = root?.querySelector('[data-overlay]');
      if (!host || !root || !layer) throw new Error('no chrome host');
      const computed = getComputedStyle(layer);
      const html = document.documentElement.getBoundingClientRect();
      const box = layer.getBoundingClientRect();
      return {
        hostParent: host.parentElement === document.documentElement,
        zIndex: computed.zIndex,
        position: computed.position,
        pointerEvents: computed.pointerEvents,
        ariaHidden: layer.getAttribute('aria-hidden'),
        inHostRoot: layer.getRootNode() === root,
        coversPage:
          Math.abs(box.top - html.top) <= 1 &&
          Math.abs(box.height - html.height) <= 1 &&
          Math.abs(box.width - html.width) <= 1,
      };
    });
    expect(facts).toEqual({
      hostParent: true,
      zIndex: '2',
      position: 'absolute',
      pointerEvents: 'none',
      ariaHidden: 'true',
      inHostRoot: true,
      coversPage: true,
    });
    // the shell itself holds no layer any more
    await expect(page.locator(`${HOST} ${LAYER}`)).toHaveCount(0);

    // the spacer's top is scrolled out of the frame, and its outline is not
    // clipped to the frame: it reaches above it, as the page does
    const content = await frameContentBox(page);
    const outline = await chromeBoxOf(page, OUTLINE);
    expect(outline.y).toBeLessThan(content.y);
    expect(outline.height).toBeGreaterThan(content.height);
    await expect(frame.locator('.spacer')).toBeAttached();
  });
});

test.describe('the outline follows its element', () => {
  test('after scrolling by 300 and by 600 and back', async ({ page }) => {
    await openShell(page, '/?_edit=1', '.spacer');
    const frame = await framedSite(page);
    await hoverSpacer(page);
    await expectOutlineOver(page, frame, '.spacer');
    const start = await frame.evaluate(() => window.scrollY);

    // the pointer stays over the 1600px spacer for all of these
    for (const top of [start + 300, start + 600, start]) {
      await frame.evaluate((wanted) => {
        window.scrollTo({ top: wanted, behavior: 'instant' });
      }, top);
      await expectOutlineOver(page, frame, '.spacer');
    }
  });

  test('after the frame reloads', async ({ page }) => {
    await openShell(page, '/?_edit=1', '.variant-plain h2');
    const before = await framedSite(page);
    await before.evaluate(() => {
      (window as Window & { __beforeReload?: boolean }).__beforeReload = true;
    });
    await page.locator(FRAME).evaluate((element) => {
      if (!(element instanceof HTMLIFrameElement)) throw new Error('no frame');
      element.contentWindow?.location.reload();
    });
    // the reloaded document carries no marker and has run its scripts
    await expect
      .poll(async () => {
        const current = await framedSite(page);
        return await current
          .evaluate(
            () =>
              (window as Window & { __beforeReload?: boolean })
                .__beforeReload === undefined &&
              (window as Window & { __siteScriptsReady?: boolean })
                .__siteScriptsReady === true,
          )
          .catch(() => false);
      })
      .toBe(true);

    const frame = await framedSite(page);
    await hover(page, '.variant-plain h2');
    await expect(chrome(page).locator(CHIP)).toHaveText('Heading');
    await expectOutlineOver(page, frame, '.variant-plain h2');
  });
});

test.describe('the chip', () => {
  test('labels a block the host no longer declares "{type} (unavailable)"', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1', '.variant-plain h2');
    const frame = await framedSite(page);
    await hover(page, '[data-pk-unavailable]');
    await expect(chrome(page).locator(CHIP)).toHaveText(
      'retired-widget (unavailable)',
    );
    await expectOutlineOver(page, frame, '[data-pk-unavailable]');
  });
});

test.describe('the pointer', () => {
  test('hides the outline when it moves onto the sidebar or the stage around the frame', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.variant-plain h2');
    await hover(page, '.variant-plain h2');
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);

    await page.mouse.move(120, 400);
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(0);
    await expect(chrome(page).locator(CHIP)).toHaveCount(0);

    await hover(page, '.variant-plain h2');
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);
    // the 24px of stage between the sidebar and the frame
    const content = await frameContentBox(page);
    await page.mouse.move(content.x - 12, 400);
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(0);
  });

  test('moves the outline to the block under it, and looks the pointer up again after the frame scrolls under it', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.spacer');
    const frame = await framedSite(page);
    await hoverSpacer(page);

    // scroll until the pointer is over something else; the browser sends no
    // pointer event for that, so the shell looks it up once the scroll ends
    await frame.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await expect(chrome(page).locator(CHIP)).not.toHaveText('Spacer');
    await expectOutlineOver(page, frame, '.variant-plain');
  });
});

test.describe('the site stays untouched', () => {
  test('keeps its scrolling, and receives every pointer move', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.variant-plain h2');
    const frame = await framedSite(page);
    await frame.evaluate(() => {
      const probe = window as Window & { __pointerMoves?: number };
      probe.__pointerMoves = 0;
      window.addEventListener('pointermove', () => {
        probe.__pointerMoves = (probe.__pointerMoves ?? 0) + 1;
      });
    });

    // hover the accordion's trigger with the overlay drawn
    await hover(page, '[data-accordion] button');
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);
    await expect(chrome(page).locator(CHIP)).toHaveText('Accordion');

    // and the wheel scrolls the frame, not the window around it
    await hover(page, '.variant-plain h2');
    const before = await frame.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBeGreaterThan(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // the bubble-phase listener on the frame's window, which runs after the
    // shell's own on the root element, saw the pointer all along
    expect(
      await frame.evaluate(
        () =>
          (window as Window & { __pointerMoves?: number }).__pointerMoves ?? 0,
      ),
    ).toBeGreaterThan(0);
  });

  test('gets no class, style, attribute or element from hovering', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1', '.variant-plain h2');
    const frame = await framedSite(page);
    const snapshot = async () =>
      await frame.evaluate(() => ({
        html: document.documentElement.outerHTML,
        sheets: document.styleSheets.length,
        adopted: document.adoptedStyleSheets.length,
        styled: document.querySelectorAll('[style]').length,
      }));
    const before = await snapshot();

    await hover(page, '.variant-plain h2');
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);
    await hover(page, '[data-accordion] button');
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(1);
    await page.mouse.move(120, 400);
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(0);

    expect(await snapshot()).toEqual(before);
  });
});

test.describe('who gets the overlay', () => {
  test('a read-only session has no overlay layer at all', async ({ page }) => {
    await page.context().clearCookies();
    await signIn(page, e2eUsers().viewer);
    await page.goto('/?_edit=1');
    await waitForShell(page);
    await expect(page.locator(`${HOST} [role="note"]`)).toBeVisible();
    await expect(chrome(page).locator(LAYER)).toHaveCount(0);

    const heading = await boxOf(await framedSite(page), '.variant-plain h2');
    await page.mouse.move(heading.x + 20, heading.y + 5);
    await expect(chrome(page).locator(OUTLINE)).toHaveCount(0);
    await expect(chrome(page).locator(CHIP)).toHaveCount(0);
  });
});
