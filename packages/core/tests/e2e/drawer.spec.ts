/**
 * The full-width layout's rail tools and panel drawer, in a real browser: the
 * drawer pushes the framed site narrower instead of covering it, and everything
 * an editor needs (mode, undo, redo, save status, Blocks, Properties) works from
 * the rail.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  FRAME,
  framedSite,
  HOST,
  openEditor,
  SELECTED,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  paragraph,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const RAIL = `${HOST} [data-rail]`;
const DRAWER = `${HOST} [data-drawer-panel]`;
const FRAMED_TOGGLE = `${HOST} [data-sidebar] [data-layout-toggle]`;

/** The rail's own buttons, by their accessible name. */
function railButton(page: Page, name: string | RegExp) {
  return page.locator(RAIL).getByRole('button', { name });
}

async function switchToFullWidth(page: Page): Promise<void> {
  await page.locator(FRAMED_TOGGLE).click();
  await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
}

/** Opens a page with a heading "Hello" in the full-width layout. */
async function openFullWidth(page: Page): Promise<void> {
  const created = await createEditablePage({
    blocks: [section(heading('Hello'), paragraph('Below'))],
  });
  await openEditor(page, created.path);
  await switchToFullWidth(page);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('the panel drawer', () => {
  test('opens beside the rail and pushes the frame narrower instead of covering it, and closing restores it', async ({
    page,
  }) => {
    await openFullWidth(page);
    const frame = await framedSite(page);
    const target = frame.locator('section.section').first().locator('h2');
    const before = await page.locator(FRAME).boundingBox();
    expect(before?.x).toBeCloseTo(56, 0);

    await target.dblclick();
    await target.dblclick();
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await railButton(page, 'Properties').click();
    await expect(page.locator(DRAWER)).toBeVisible();

    const drawer = await page.locator(DRAWER).boundingBox();
    const pushed = await page.locator(FRAME).boundingBox();
    expect(drawer?.width).toBeCloseTo(280, 0);
    expect(pushed?.x).toBeCloseTo((before?.x ?? 0) + 280, 0);
    expect(pushed?.width).toBeCloseTo((before?.width ?? 0) - 280, 0);
    // nothing of the drawer is drawn over the site
    expect((drawer?.x ?? 0) + (drawer?.width ?? 0)).toBeLessThanOrEqual(
      (pushed?.x ?? 0) + 1,
    );
    // the site reflowed to the narrower viewport, once
    expect(await frame.evaluate(() => window.innerWidth)).toBeCloseTo(
      (before?.width ?? 0) - 280,
      0,
    );

    // the selection is still on the heading, and its Properties are right here
    await expect(page.locator(SELECTED)).toHaveCount(1);
    const text = page.locator(DRAWER).getByRole('textbox', { name: 'Text' });
    await expect(text).toHaveValue('Hello');
    await text.press('End');
    await text.pressSequentially(' there');
    await expect(target).toHaveText('Hello there', { timeout: 1000 });

    await railButton(page, 'Properties').click();
    await expect(page.locator(DRAWER)).toBeHidden();
    const restored = await page.locator(FRAME).boundingBox();
    expect(restored?.x).toBeCloseTo(before?.x ?? 0, 0);
    expect(restored?.width).toBeCloseTo(before?.width ?? 0, 0);
    await expect(page.locator(SELECTED)).toHaveCount(1);
    await expect(target).toHaveText('Hello there');
  });
});
