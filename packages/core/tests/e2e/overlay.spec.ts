/**
 * The hover overlay on the real shell, over the adversarial theme, in three
 * engines.
 *
 * The overlay draws an outline, a dashed outline for the section around it
 * and a label chip over the block under the pointer in the framed site. It is
 * measured, not looked at: each outline's box is compared with the box the
 * site element has inside the frame, moved by where the frame's content box
 * sits in the shell.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { signIn } from './helpers/session.ts';

const HOST = 'plakboek-editor';
const FRAME = `${HOST} iframe`;
const LAYER = `${HOST} [data-overlay]`;
const OUTLINE = `${HOST} [data-overlay-outline]`;
const SECTION_OUTLINE = `${HOST} [data-overlay-section]`;
const CHIP = `${HOST} [data-overlay-chip]`;

type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

async function openShell(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
  const frame = await framedSite(page);
  await frame.waitForFunction(
    () =>
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

/** A frame element's box in the page's coordinates. */
async function boxOf(frame: Frame, selector: string): Promise<Rect> {
  const box = await frame.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box in the frame`);
  return box;
}

async function overlayBox(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box in the shell`);
  return box;
}

/**
 * Moves the pointer to the middle of the visible part of a frame element,
 * scrolling it into view first when it is not. A tall element (the spacer)
 * is aimed at the middle of the frame, where it covers the pointer whatever
 * the frame then does.
 */
async function hover(page: Page, selector: string): Promise<void> {
  const point = await page.evaluate(
    ({ host, target }) => {
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
        y: frameBox.top + iframe.clientTop + (top + bottom) / 2,
      };
    },
    { host: HOST, target: selector },
  );
  await page.mouse.move(point.x, point.y);
}

function expectNear(actual: Rect, expected: Rect, tolerance = 1): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(
    tolerance,
  );
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(
    tolerance,
  );
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('hovering a block in the framed site', () => {
  test('outlines a heading exactly over its box and labels it above', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    const selector = '.variant-plain h2';

    await hover(page, selector);
    await expect(page.locator(OUTLINE)).toHaveCount(1);

    const heading = await boxOf(frame, selector);
    expectNear(await overlayBox(page, OUTLINE), heading);

    const chip = page.locator(CHIP);
    await expect(chip).toHaveText('Heading');
    await expect(chip).toHaveAttribute('data-placement', 'above');
    const chipBox = await overlayBox(page, CHIP);
    // the chip's bottom edge rests on the outline's top edge
    expect(
      Math.abs(chipBox.y + chipBox.height - heading.y),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(chipBox.x - heading.x)).toBeLessThanOrEqual(1);
    expect(chipBox.height).toBe(20);
  });

  test('draws the 2px outline and its 1px halo, and a chip in the outline colour', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    await hover(page, '.variant-plain h2');
    await expect(page.locator(OUTLINE)).toHaveCount(1);

    const styles = await page.locator(OUTLINE).evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        borderWidth: computed.borderTopWidth,
        borderStyle: computed.borderTopStyle,
        borderColor: computed.borderTopColor,
        outlineWidth: computed.outlineWidth,
        outlineStyle: computed.outlineStyle,
        pointerEvents: computed.pointerEvents,
      };
    });
    expect(styles).toEqual({
      borderWidth: '2px',
      borderStyle: 'solid',
      borderColor: 'rgb(79, 70, 229)',
      outlineWidth: '1px',
      outlineStyle: 'solid',
      pointerEvents: 'none',
    });
    const chip = await page.locator(CHIP).evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        background: computed.backgroundColor,
        color: computed.color,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        radius: computed.borderTopLeftRadius,
        paddingLeft: computed.paddingLeft,
        maxWidth: computed.maxWidth,
        whiteSpace: computed.whiteSpace,
        textOverflow: computed.textOverflow,
      };
    });
    expect(chip).toEqual({
      background: 'rgb(79, 70, 229)',
      color: 'rgb(255, 255, 255)',
      fontSize: '12px',
      fontWeight: '600',
      radius: '4px',
      paddingLeft: '8px',
      maxWidth: '240px',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    });
  });

  test('also draws the dashed outline of the section around a block in it, without a chip of its own', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hover(page, '.variant-plain h2');
    await expect(page.locator(SECTION_OUTLINE)).toHaveCount(1);

    const section = await boxOf(frame, 'section.variant-plain');
    expectNear(await overlayBox(page, SECTION_OUTLINE), section);
    const dashed = await page.locator(SECTION_OUTLINE).evaluate((element) => {
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
    await expect(page.locator(CHIP)).toHaveCount(1);
    await expect(page.locator(CHIP)).toHaveText('Heading');
  });

  test('labels a section itself with its own chip and no dashed outline', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    // the section's own top padding holds no child block
    const section = await boxOf(frame, 'section.variant-plain');
    await page.mouse.move(section.x + section.width / 2, section.y + 4);
    await expect(page.locator(CHIP)).toHaveText('Section');
    await expect(page.locator(SECTION_OUTLINE)).toHaveCount(0);
    expectNear(await overlayBox(page, OUTLINE), section);
  });
});

/** The largest difference between any two sides of two boxes. */
function maxDelta(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );
}

/** Waits until the outline sits over the element's present box. */
async function expectOutlineOver(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const outline = await page.locator(OUTLINE).first().boundingBox();
        const element = await frame.locator(selector).first().boundingBox();
        if (outline === null || element === null) {
          return Number.POSITIVE_INFINITY;
        }
        return maxDelta(outline, element);
      },
      { message: `the outline is over ${selector}` },
    )
    .toBeLessThanOrEqual(1);
}

/** The tall block, which keeps covering the pointer through a scroll, a
 * resize or a layout change. Hovering it leaves its top scrolled out of the
 * frame. */
async function hoverSpacer(page: Page): Promise<void> {
  await hover(page, '.spacer');
  await expect(page.locator(OUTLINE)).toHaveCount(1);
  await expect(page.locator(CHIP)).toHaveText('Spacer');
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

/** Scrolls the framed site so `selector`'s top sits `top` pixels below the
 * frame's top. */
async function scrollTopTo(
  frame: Frame,
  selector: string,
  top: number,
): Promise<void> {
  await frame.evaluate(
    ({ target, wanted }) => {
      const rect = document.querySelector(target)?.getBoundingClientRect();
      if (rect === undefined) throw new Error(`${target} is not in the frame`);
      window.scrollBy({ top: rect.top - wanted, behavior: 'instant' });
    },
    { target: selector, wanted: top },
  );
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

  for (const [name, selector, label] of CASES) {
    test(`outlines ${name} at its real position`, async ({ page }) => {
      await openShell(page, '/?_edit=1');
      const frame = await framedSite(page);
      await hover(page, selector);
      await expect(page.locator(CHIP)).toHaveText(label);
      await expectOutlineOver(page, frame, selector);
    });
  }

  test('draws the layer above the frame, over exactly its content box and clipped to it', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);

    const facts = await page.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      const layer = root?.querySelector('[data-overlay]');
      const iframe = root?.querySelector('iframe');
      const stage = iframe?.closest('[role="region"]');
      if (!layer || !iframe || !stage) throw new Error('shell parts missing');
      const computed = getComputedStyle(layer);
      return {
        zIndex: computed.zIndex,
        position: computed.position,
        overflow: computed.overflow,
        pointerEvents: computed.pointerEvents,
        ariaHidden: layer.getAttribute('aria-hidden'),
        frameZIndex: getComputedStyle(iframe).zIndex,
        afterTheStage: Boolean(
          stage.compareDocumentPosition(layer) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        inShadowRoot: layer.getRootNode() === root,
      };
    }, HOST);
    expect(facts).toEqual({
      zIndex: '2',
      position: 'absolute',
      overflow: 'hidden',
      pointerEvents: 'none',
      ariaHidden: 'true',
      frameZIndex: 'auto',
      afterTheStage: true,
      inShadowRoot: true,
    });

    const content = await frameContentBox(page);
    expectNear(await overlayBox(page, LAYER), content);
    // the spacer's top is scrolled out, so its outline reaches above the
    // layer, which clips it
    const outline = await overlayBox(page, OUTLINE);
    expect(outline.y).toBeLessThan(content.y);
    expect(outline.height).toBeGreaterThan(content.height);
    await expect(frame.locator('.spacer')).toBeAttached();
  });
});

test.describe('the outline follows its element', () => {
  test('through a scroll of the frame', async ({ page }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);
    await expectOutlineOver(page, frame, '.spacer');
    const before = await overlayBox(page, OUTLINE);

    await frame.evaluate(() => {
      window.scrollBy({ top: 300, behavior: 'instant' });
    });
    await expectOutlineOver(page, frame, '.spacer');
    const after = await overlayBox(page, OUTLINE);
    expect(Math.abs(before.y - after.y - 300)).toBeLessThanOrEqual(1);
  });

  test('through a resize of the window', async ({ page }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);
    const before = await frameContentBox(page);

    await page.setViewportSize({ width: 1200, height: 760 });
    await expect
      .poll(async () => (await frameContentBox(page)).height)
      .not.toBe(before.height);
    await expectOutlineOver(page, frame, '.spacer');
    expectNear(await overlayBox(page, LAYER), await frameContentBox(page));
  });

  test('through the layout toggle, both ways', async ({ page }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);
    const framed = await overlayBox(page, OUTLINE);

    // by keyboard, so the pointer stays over the frame
    const toggle = page.locator(`${HOST} [data-sidebar] button[aria-pressed]`);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    await expectOutlineOver(page, frame, '.spacer');
    const full = await overlayBox(page, OUTLINE);
    expect(framed.x - full.x).toBeGreaterThan(100);
    expectNear(await overlayBox(page, LAYER), await frameContentBox(page));

    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    await expectOutlineOver(page, frame, '.spacer');
    expectNear(await overlayBox(page, OUTLINE), framed);
  });

  test('through a change of the page above it', async ({ page }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);
    const before = await overlayBox(page, OUTLINE);
    const spacerBefore = await boxOf(frame, '.spacer');

    // the site's own script opens the second accordion (the first sits in a
    // section of fixed height), which pushes everything below it down
    await frame.evaluate(() => {
      // a browser keeps what is on screen in place when content above it
      // grows (scroll anchoring); switch that off so the page really moves.
      // Chromium and Firefox read the viewport's overflow-anchor from the
      // root, WebKit reads it from body: with only the root set, WebKit kept
      // the spacer in place by scrolling the frame exactly as far as the
      // panel grew
      document.documentElement.style.overflowAnchor = 'none';
      document.body.style.overflowAnchor = 'none';
      const trigger = document.querySelectorAll('[data-accordion] button')[1];
      if (!(trigger instanceof HTMLElement)) throw new Error('no accordion');
      trigger.click();
    });
    await expect(
      frame.locator('[data-accordion] button').nth(1),
    ).toHaveAttribute('aria-expanded', 'true');
    // the precondition of this test: the spacer really moved down
    await expect
      .poll(async () => (await boxOf(frame, '.spacer')).y - spacerBefore.y, {
        message: 'the spacer moved down',
      })
      .toBeGreaterThan(5);
    await expectOutlineOver(page, frame, '.spacer');
    const after = await overlayBox(page, OUTLINE);
    expect(after.y - before.y).toBeGreaterThan(5);
  });

  test('after the frame reloads', async ({ page }) => {
    await openShell(page, '/?_edit=1');
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
    await expect(page.locator(CHIP)).toHaveText('Heading');
    await expectOutlineOver(page, frame, '.variant-plain h2');
  });
});

test.describe('the chip', () => {
  test('rests above the outline, moves inside it near the frame top, and pins to the frame top once the element top scrolls out', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);
    const content = await frameContentBox(page);

    // the spacer's top is far above the frame's: pinned 4px below its top
    await expect(page.locator(CHIP)).toHaveAttribute(
      'data-placement',
      'pinned',
    );
    const pinned = await overlayBox(page, CHIP);
    expect(Math.abs(pinned.y - (content.y + 4))).toBeLessThanOrEqual(1);
    expect(pinned.x).toBeGreaterThanOrEqual(content.x);

    // room above: the chip rests on the outline
    await scrollTopTo(frame, '.spacer', 60);
    await expect(page.locator(CHIP)).toHaveAttribute('data-placement', 'above');
    const above = await overlayBox(page, CHIP);
    const outlineAbove = await overlayBox(page, OUTLINE);
    expect(
      Math.abs(above.y + above.height - outlineAbove.y),
    ).toBeLessThanOrEqual(1);

    // less than 20px of room: the chip moves 4px into the outline
    await scrollTopTo(frame, '.spacer', 6);
    await expect(page.locator(CHIP)).toHaveAttribute(
      'data-placement',
      'inside',
    );
    const inside = await overlayBox(page, CHIP);
    const outlineInside = await overlayBox(page, OUTLINE);
    expect(Math.abs(inside.y - (outlineInside.y + 4))).toBeLessThanOrEqual(1);
    expect(Math.abs(inside.x - (outlineInside.x + 4))).toBeLessThanOrEqual(1);
  });

  test('labels a block the host no longer declares "{type} (unavailable)"', async ({
    page,
  }) => {
    await openShell(page, '/about?_edit=1');
    const frame = await framedSite(page);
    await hover(page, '[data-pk-unavailable]');
    await expect(page.locator(CHIP)).toHaveText('retired-widget (unavailable)');
    await expectOutlineOver(page, frame, '[data-pk-unavailable]');
  });

  test('is one line with an ellipsis when its text is long', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    // a stand-in label too long for 240px, set on the frame element the
    // overlay reads
    await frame.evaluate(() => {
      document
        .querySelector('.variant-plain h2')
        ?.setAttribute(
          'data-pk-label',
          'A label far too long to fit in a chip that stops at two hundred and forty pixels',
        );
    });
    await hover(page, '.variant-plain h2');
    await expect(page.locator(CHIP)).toContainText('A label far too long');
    const chip = await overlayBox(page, CHIP);
    expect(chip.width).toBeLessThanOrEqual(240);
    expect(chip.height).toBe(20);
    expect(
      await page
        .locator(CHIP)
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
  });
});

test.describe('the pointer', () => {
  test('hides the outline when it moves onto the sidebar or the stage around the frame', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    await hover(page, '.variant-plain h2');
    await expect(page.locator(OUTLINE)).toHaveCount(1);

    await page.mouse.move(120, 400);
    await expect(page.locator(OUTLINE)).toHaveCount(0);
    await expect(page.locator(CHIP)).toHaveCount(0);

    await hover(page, '.variant-plain h2');
    await expect(page.locator(OUTLINE)).toHaveCount(1);
    // the 24px of stage between the sidebar and the frame
    const content = await frameContentBox(page);
    await page.mouse.move(content.x - 12, 400);
    await expect(page.locator(OUTLINE)).toHaveCount(0);
  });

  test('moves the outline to the block under it, and looks the pointer up again after the frame scrolls under it', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await hoverSpacer(page);

    // scroll until the pointer is over something else; the browser sends no
    // pointer event for that, so the shell looks it up once the scroll ends
    await frame.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await expect(page.locator(CHIP)).not.toHaveText('Spacer');
    await expectOutlineOver(page, frame, '.variant-plain');
  });
});

test.describe('the site stays untouched', () => {
  test('keeps its clicks, keyboard and scrolling, and receives every pointer event', async ({
    page,
  }) => {
    await openShell(page, '/?_edit=1');
    const frame = await framedSite(page);
    await frame.evaluate(() => {
      const probe = window as Window & { __pointerMoves?: number };
      probe.__pointerMoves = 0;
      window.addEventListener('pointermove', () => {
        probe.__pointerMoves = (probe.__pointerMoves ?? 0) + 1;
      });
    });

    // hover the accordion's trigger with the overlay drawn, then click it
    await hover(page, '[data-accordion] button');
    await expect(page.locator(OUTLINE)).toHaveCount(1);
    await expect(page.locator(CHIP)).toHaveText('Accordion');
    const trigger = frame.locator('[data-accordion] button').first();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(OUTLINE)).toHaveCount(1);

    // the keyboard reaches the site too
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // and the wheel scrolls the frame, not the window around it
    await hoverSpacer(page);
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
    await openShell(page, '/?_edit=1');
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
    await expect(page.locator(OUTLINE)).toHaveCount(1);
    await hover(page, '[data-accordion] button');
    await expect(page.locator(OUTLINE)).toHaveCount(1);
    await page.mouse.move(120, 400);
    await expect(page.locator(OUTLINE)).toHaveCount(0);

    expect(await snapshot()).toEqual(before);
  });
});

test.describe('who gets the overlay', () => {
  test('a read-only session has no overlay layer at all', async ({ page }) => {
    await page.context().clearCookies();
    await signIn(page, e2eUsers().viewer);
    await openShell(page, '/?_edit=1');
    await expect(page.locator(`${HOST} [role="note"]`)).toBeVisible();
    await expect(page.locator(LAYER)).toHaveCount(0);

    const heading = await boxOf(await framedSite(page), '.variant-plain h2');
    await page.mouse.move(heading.x + 20, heading.y + 5);
    await expect(page.locator(OUTLINE)).toHaveCount(0);
    await expect(page.locator(CHIP)).toHaveCount(0);
  });
});

test.describe('motion', () => {
  test('fades the outline in over 100ms, and not at all under reduced motion', async ({
    page,
  }) => {
    const animation = async () =>
      await page.locator(OUTLINE).evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          name: computed.animationName,
          duration: computed.animationDuration,
        };
      });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openShell(page, '/?_edit=1');
    await hover(page, '.variant-plain h2');
    await expect(page.locator(OUTLINE)).toHaveCount(1);
    expect(await animation()).toEqual({
      name: 'pk-overlay-in',
      duration: '0.1s',
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(animation).toEqual({ name: 'none', duration: '0s' });
  });
});
