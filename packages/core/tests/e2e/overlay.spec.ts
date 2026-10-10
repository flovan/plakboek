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

/** Moves the pointer to the middle of a frame element, scrolling it into
 * view first when it is not. */
async function hover(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<void> {
  await frame
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 120 || rect.bottom > window.innerHeight - 120) {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    });
  const box = await boxOf(frame, selector);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
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

    await hover(page, frame, selector);
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
    const frame = await framedSite(page);
    await hover(page, frame, '.variant-plain h2');
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
    await hover(page, frame, '.variant-plain h2');
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
