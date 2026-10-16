/**
 * The focused Properties mode in a real browser: a double-click on a heading
 * opens its Properties in a sheet over the sidebar, editing updates the page,
 * and Close brings the sidebar back.
 */
import { expect, test, type Page } from '@playwright/test';
import {
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
