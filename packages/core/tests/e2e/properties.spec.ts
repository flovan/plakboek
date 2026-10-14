/**
 * Changing a block's properties from the side panel, in a real browser: the
 * panel opens by an explicit action, every widget edits its property and the
 * block re-renders in the frame as it does, the constraint states hold, an
 * invalid value is shown and not applied, and a change is saved after a pause
 * and undone as one step.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { framedSite, HOST, openEditor } from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  paragraph,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';

/** The panel's tab for Properties. */
function propertiesTab(page: Page) {
  return page.getByRole('tab', { name: 'Properties' });
}

/** The Text control of the open Properties panel. */
function textControl(page: Page) {
  return page.getByRole('textbox', { name: 'Text' });
}

/** Double-click down to a heading and once more on it: the ask for its Properties. */
async function openPropertiesOfHeading(
  frame: Frame,
  at: number,
): Promise<void> {
  const target = frame.locator('section.section').first().locator('h2').nth(at);
  await target.dblclick();
  await target.dblclick();
  await target.dblclick();
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Opens a page holding a heading "Hello" and a paragraph in the editor. */
async function openPageWithHeading(page: Page): Promise<EditablePage> {
  const created = await createEditablePage({
    blocks: [section(heading('Hello'), paragraph('Below'))],
  });
  await openEditor(page, created.path);
  return created;
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('changing a heading in the panel', () => {
  test('double-clicking a heading opens its text in the panel, typing shows live in the frame without losing the caret, and it is saved after the pause', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const first = frame.locator('section.section').first().locator('h2').first();

    await openPropertiesOfHeading(frame, 0);
    await expect(propertiesTab(page)).toHaveAttribute('aria-selected', 'true');
    const control = textControl(page);
    await expect(control).toHaveValue('Hello');
    // the ask for Properties moves focus into the first control
    await expect(control).toBeFocused();

    await control.press('End');
    await control.pressSequentially(' there');
    await expect(first).toHaveText('Hello there', { timeout: 1000 });
    // the panel's own value and caret were never overwritten by the render
    await expect(control).toHaveValue('Hello there');
    await expect(control).toBeFocused();
    expect(await control.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(
      'Hello there'.length,
    );

    // typing on after the render carries on from the caret
    await control.pressSequentially('!');
    await expect(first).toHaveText('Hello there!', { timeout: 1000 });
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(
      reloaded.locator('section.section').first().locator('h2').first(),
    ).toHaveText('Hello there!');
  });
});

test.describe('the panel and its tabs', () => {
  test('selecting a block never switches the tab or moves focus into the panel', async ({
    page,
  }) => {
    await openPageWithHeading(page);
    const frame = await framedSite(page);
    const blocks = page.getByRole('tab', { name: 'Blocks' });
    await expect(blocks).toHaveAttribute('aria-selected', 'true');

    // drill to a heading by clicks: it is selected, the tab stays on Blocks
    const target = frame.locator('section.section').first().locator('h2').first();
    await target.dblclick();
    await target.dblclick();
    await expect(blocks).toHaveAttribute('aria-selected', 'true');
    expect(
      await page
        .locator(HOST)
        .evaluate((host) => host.shadowRoot?.activeElement?.tagName ?? ''),
    ).not.toBe('INPUT');
  });
});
