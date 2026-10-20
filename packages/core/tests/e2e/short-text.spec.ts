/**
 * Typing short text in place: a heading's words are retyped on the page as one
 * plain line with the property's own length limit, Enter ends the field, and
 * what was typed is saved.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import { framedSite, HOST, openEditor, selectedId } from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  readBlockProps,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';
/** The e2e host's heading allows 200 characters. */
const LIMIT = 200;

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

/** Opens a page holding one heading with `text`. */
async function openHeading(
  page: Parameters<typeof openEditor>[0],
  text: string,
): Promise<{ frame: Frame; field: Locator; pageId: string; path: string }> {
  const created = await createEditablePage({
    blocks: [section(heading(text))],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return {
    frame,
    field: frame.locator('h2.reset-target').first(),
    pageId: created.pageId,
    path: created.path,
  };
}

test('one click on a heading, a retype and Enter: the session ends with the block selected and the new title is still there after a reload', async ({
  page,
}) => {
  const { field } = await openHeading(page, 'A short title');
  // a click in the middle of the words starts the session on the heading itself
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field).toHaveAttribute('contenteditable', 'true');
  expect(await field.evaluate((element) => element.tagName)).toBe('H2');
  const id = await selectedId(page);
  expect(id).not.toBeNull();

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('A new title');
  await expect(field).toHaveText('A new title');
  // Enter ends the field like Done, with no line break typed
  await page.keyboard.press('Enter');
  await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  expect(await selectedId(page)).toBe(id);
  await expect(field).toHaveText('A new title');
  await expect(page.getByText(SAVED)).toBeVisible();

  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('h2.reset-target').first()).toHaveText(
    'A new title',
  );
});

test('typing stops at the heading limit, counted as the server counts', async ({
  page,
}) => {
  const seed = 'x'.repeat(LIMIT - 5);
  const { field, pageId } = await openHeading(page, 'A short title');
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  // 195 characters go in at once (they fit); the caret is after them
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(seed);
  await expect(field).toHaveText(seed);
  await page.keyboard.type('abcdefghij');
  await expect(field).toHaveText(`${seed}abcde`);
  expect(((await field.textContent()) ?? '').length).toBe(LIMIT);

  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await readBlockProps(pageId, 'heading'))['text'])
    .toBe(`${seed}abcde`);
});
