/**
 * Reaching a block that renders at no size again, in a real browser: an
 * inserted Text with no text is a zero-height paragraph, and the pointer must
 * find it through the box the overlay draws it from, by drilling, by a click
 * at its column's scope, by hover and by its "Needs input" badge.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  boxOf,
  frameBoxOf,
  framedSite,
  HOST,
  LIVE_REGION,
  openEditor,
  SELECTED,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const EMPTY = 'p[data-pk-type="text"]';
const SELECTED_EMPTY = 'Selected Text, 2 of 3 in Column 1. Needs input.';

/** H1, an empty Text and H2 in one column. */
async function pageWithEmptyText(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [
      section(heading('H1'), { type: 'text', props: {} }, heading('H2')),
    ],
  });
}

/** A point 40px in and 8px down from the empty paragraph's top-left, inside its ghost box. */
async function ghostPoint(frame: Frame): Promise<{ x: number; y: number }> {
  const box = await frameBoxOf(frame, EMPTY);
  expect(box.height).toBe(0);
  return { x: box.x + 40, y: box.y + 8 };
}

/** The outline settles to the paragraph's top and the 24px ghost height. */
async function expectGhostBox(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<void> {
  const paragraph = await frameBoxOf(frame, EMPTY);
  await expect
    .poll(async () => {
      const outline = await boxOf(page, selector);
      return [Math.round(outline.y - paragraph.y), Math.round(outline.height)];
    })
    .toEqual([0, 24]);
}

async function drillTwice(frame: Frame, name: string): Promise<void> {
  const target = frame.getByRole('heading', { name });
  await target.dblclick();
  await target.dblclick();
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

async function open(page: Page): Promise<Frame> {
  const created = await pageWithEmptyText();
  await openEditor(page, created.path);
  return await framedSite(page);
}

test.describe('an empty block can be selected again', () => {
  test('by double-click drilling from nothing selected', async ({ page }) => {
    const frame = await open(page);
    const { x, y } = await ghostPoint(frame);

    await page.mouse.dblclick(x, y);
    await page.mouse.dblclick(x, y);

    await expect(page.locator(LIVE_REGION)).toHaveText(SELECTED_EMPTY);
    await expectGhostBox(page, frame, SELECTED);
  });

  test('by a click when its column is the scope', async ({ page }) => {
    const frame = await open(page);
    const { x, y } = await ghostPoint(frame);

    await drillTwice(frame, 'H1');
    await page.mouse.click(x, y);

    await expect(page.locator(LIVE_REGION)).toHaveText(SELECTED_EMPTY);
  });

  test('hover outlines it at its ghost box', async ({ page }) => {
    const frame = await open(page);
    const { x, y } = await ghostPoint(frame);
    const id = await frame.locator(EMPTY).getAttribute('data-pk-block');

    await drillTwice(frame, 'H1');
    await page.mouse.move(x, y);

    await expectGhostBox(
      page,
      frame,
      `${HOST} [data-overlay-target="${id}"] [data-overlay-outline]`,
    );
  });

  test('by its Needs input badge, which opens its Properties on the empty control', async ({
    page,
  }) => {
    const frame = await open(page);
    const marker = page.locator(`${HOST} [data-marker]`);

    await drillTwice(frame, 'H2');
    await marker.click();

    await expect(page.locator(LIVE_REGION)).toHaveText(SELECTED_EMPTY);
    const field = page.getByRole('textbox', { name: 'Text' });
    await expect(field).toBeFocused();
    await field.fill('Filled');
    await expect(frame.locator(EMPTY)).toHaveText('Filled');
    await expect(marker).toHaveCount(0);
  });
});
