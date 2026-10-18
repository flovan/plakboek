/**
 * The focused Properties mode in a real browser: a double-click on a heading
 * opens its Properties in a sheet over the sidebar, editing updates the page,
 * and Close brings the sidebar back.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  FRAME,
  framedSite,
  HOST,
  MODE_GROUP,
  openEditor,
  regionFocused,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  paragraph,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SHEET = `${HOST} [data-properties-sheet]`;

/** Three double-clicks reach a leaf and ask for its Properties. */
async function openPropertiesOfHeading(page: Page): Promise<void> {
  const frame = await framedSite(page);
  const target = frame.locator('section.section h2').first();
  await target.dblclick();
  await target.dblclick();
  await target.dblclick();
}

async function openPageWithHeading(page: Page): Promise<void> {
  const created = await createEditablePage({
    blocks: [section(heading('Hello'), paragraph('Below'))],
  });
  await openEditor(page, created.path);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('the Properties sheet in the framed layout', () => {
  test('slides over the sidebar, edits the page, and Close brings the sidebar back', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);

    await openPropertiesOfHeading(page);
    await expect(page.locator(SHEET)).toHaveAttribute('data-open', '');
    const control = page.getByRole('textbox', { name: 'Text' });
    await expect(control).toBeFocused();
    await expect(page.locator(`${HOST} [data-sidebar]`)).toBeHidden();

    await control.press('End');
    await control.pressSequentially(' there');
    await expect(frame.locator('section.section h2').first()).toHaveText(
      'Hello there',
      { timeout: 1000 },
    );

    await page.getByRole('button', { name: 'Close properties' }).click();
    await expect(page.locator(SHEET)).not.toHaveAttribute('data-open', '');
    await expect(page.locator(MODE_GROUP)).toBeVisible();
    await expect.poll(() => regionFocused(page)).toBe(true);
  });
});

test.describe('the Properties sheet in the full-width layout', () => {
  test('slides over the drawer without moving the frame, and Escape closes the sheet before the drawer', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    await page.locator(`${HOST} [data-sidebar] [data-layout-toggle]`).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    const frame = await framedSite(page);
    const before = await page.locator(FRAME).boundingBox();

    await openPropertiesOfHeading(page);
    const drawer = page.locator(`${HOST} [data-drawer-panel]`);
    await expect(
      drawer.locator('[data-properties-sheet][data-open]'),
    ).toBeVisible();
    const pushed = await page.locator(FRAME).boundingBox();
    expect(pushed?.x).toBeCloseTo((before?.x ?? 0) + 280, 0);

    const control = page.getByRole('textbox', { name: 'Text' });
    await expect(control).toBeFocused();
    await control.press('End');
    await control.pressSequentially(' there');
    await expect(frame.locator('section.section h2').first()).toHaveText(
      'Hello there',
      { timeout: 1000 },
    );

    await page.keyboard.press('Escape');
    await expect(page.locator(SHEET)).not.toHaveAttribute('data-open', '');
    await expect(drawer).toBeVisible();

    // Escape inside the drawer closes it once the sheet is out of the way
    await drawer.getByRole('treeitem').first().focus();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});

test.describe('what the sheet carries and when it closes', () => {
  test('shows the save status once, inside the sheet, and Interact closes the sheet', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    await openPropertiesOfHeading(page);
    const control = page.getByRole('textbox', { name: 'Text' });
    await control.press('End');
    await control.pressSequentially('!');

    const saved = page.getByText('All changes saved');
    await expect(saved).toHaveCount(1);
    await expect(
      page.locator(SHEET).getByText('All changes saved'),
    ).toBeVisible();

    await page.locator(`${HOST} #plakboek-stage`).focus();
    await page.keyboard.press('i');
    await expect(page.locator(SHEET)).not.toHaveAttribute('data-open', '');
    await expect(page.locator(MODE_GROUP)).toBeVisible();
  });
});
