/**
 * The whole structure flow with no pointer: an editor adds a section, a
 * heading and a text through the picker, fills their values, moves the text
 * above the heading with Alt+Arrow and back with the handle's keyboard drag,
 * duplicates, deletes, undoes and redoes, and the page that is left is the one
 * that comes back after a reload. Only `keyboard.press` and `keyboard.type`
 * drive the editor.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  framedSite,
  HOST,
  LIVE_REGION,
  openEditor,
  SELECTED,
  regionFocused,
  tabToRegion,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import { createEditablePage } from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';
const HANDLE = `${HOST} [data-drag-handle]`;

/** Presses Tab until `selector` (in the shell) holds focus. */
async function tabUntilFocused(page: Page, selector: string): Promise<void> {
  const focused = () =>
    page
      .locator(selector)
      .first()
      .evaluate(
        (element) =>
          (element.getRootNode() as ShadowRoot).activeElement === element,
      );
  for (let presses = 0; presses < 40; presses += 1) {
    if (await focused()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`${selector} never took focus`);
}

test('the whole structure flow is done with the keyboard alone, and the page that is left persists', async ({
  page,
}) => {
  await signIn(page, e2eUsers().editor);
  const created = await createEditablePage({ blocks: [] });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const order = () =>
    frame
      .locator('section.section')
      .locator('h2, p')
      .evaluateAll((elements) =>
        elements.map(
          (element) =>
            `${element.tagName.toLowerCase()}:${element.textContent}`,
        ),
      );
  const picker = page.getByRole('dialog', { name: 'Add a block' });

  // a section, from the empty page's own prompt
  await tabUntilFocused(page, `${HOST} [data-empty-page] button`);
  await page.keyboard.press('Enter');
  await expect(frame.locator('section.section')).toHaveCount(1);

  // its column is empty and offers a prompt, which opens the picker
  await tabUntilFocused(page, `${HOST} [data-empty-add]`);
  await page.keyboard.press('Enter');
  await expect(picker).toBeVisible();
  await page.keyboard.type('head');
  await page.keyboard.press('Enter');
  await expect(frame.locator('section.section h2')).toHaveCount(1);

  // the new heading needs its text: Properties opens on it
  const control = page.getByRole('textbox', { name: 'Text' });
  await expect(control).toBeFocused();
  await page.keyboard.type('Keyboard title');
  await page.keyboard.press('Tab');
  await expect(frame.locator('section.section h2')).toHaveText(
    'Keyboard title',
  );
  await expect(page.getByText(SAVED)).toBeVisible();

  // a text after it
  await tabToRegion(page);
  await page.keyboard.press('+');
  await expect(picker).toBeVisible();
  await page.keyboard.type('tex');
  await page.keyboard.press('Enter');
  await expect(control).toBeFocused();
  await page.keyboard.type('Keyboard body');
  await page.keyboard.press('Tab');
  await expect.poll(order).toEqual(['h2:Keyboard title', 'p:Keyboard body']);

  // Alt+ArrowUp lifts the text over the heading
  await tabToRegion(page);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(order).toEqual(['p:Keyboard body', 'h2:Keyboard title']);

  // the handle's keyboard drag puts it back
  await tabUntilFocused(page, HANDLE);
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect.poll(order).toEqual(['h2:Keyboard title', 'p:Keyboard body']);
  await expect(page.getByText(SAVED)).toBeVisible();

  // climb to the column, drill back in to the heading, step on to the text
  await tabToRegion(page);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(SELECTED)).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(LIVE_REGION)).toContainText('Selected Text');

  // a copy, then its removal, undone and redone
  await page.keyboard.press('ControlOrMeta+D');
  await expect.poll(order).toHaveLength(3);
  expect(await regionFocused(page)).toBe(true);
  await page.keyboard.press('Delete');
  await expect.poll(order).toHaveLength(2);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(order).toHaveLength(3);
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect.poll(order).toHaveLength(2);
  await expect(page.getByText(SAVED)).toBeVisible();

  await page.reload();
  const reloaded = await framedSite(page);
  await expect(
    reloaded.locator('section.section h2, section.section p'),
  ).toHaveText(['Keyboard title', 'Keyboard body']);
});
