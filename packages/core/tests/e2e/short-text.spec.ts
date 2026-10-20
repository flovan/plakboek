/**
 * Typing short text in place: a heading's words are retyped on the page as one
 * plain line with the property's own length limit, Enter ends the field, and
 * what was typed is saved.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import {
  chrome,
  framedSite,
  HOST,
  openEditor,
  selectedId,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  paragraph,
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

const BAR = '[data-field-bar]';

test.describe('the compact field bar', () => {
  test('sits 8px above the heading on its left edge, counts the characters, and Done ends the session', async ({
    page,
  }) => {
    // a paragraph above gives the heading room for the bar
    const created = await createEditablePage({
      blocks: [section(paragraph('Intro '.repeat(60)), heading('Hello'))],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const field = frame.locator('h2.reset-target').first();
    await field.click();
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');

    const bar = chrome(page).locator(BAR);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-placement', 'above');
    await expect(bar).toHaveAttribute('role', 'toolbar');
    await expect(bar).toHaveAttribute('aria-label', /^Editing /);
    const barBox = await bar.boundingBox();
    const fieldBox = await field.boundingBox();
    if (barBox === null || fieldBox === null) throw new Error('No boxes');
    expect(Math.abs(barBox.y + barBox.height + 8 - fieldBox.y)).toBeLessThan(2);
    expect(Math.abs(barBox.x - fieldBox.x)).toBeLessThan(2);

    await expect(bar).toContainText('5 of 200 characters');
    await page.keyboard.type('!!');
    await expect(bar).toContainText('7 of 200 characters');

    await bar.getByRole('button', { name: 'Done editing' }).click();
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    await expect(bar).toHaveCount(0);
    await expect(field).toHaveText('Hello!!');
  });

  test('the bar flips below a heading that scrolls near the top of the frame, and the session goes on', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(
          ...Array.from({ length: 30 }, () => paragraph('Intro '.repeat(40))),
          heading('Near top'),
          ...Array.from({ length: 30 }, () => paragraph('Outro '.repeat(40))),
        ),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const field = frame.locator('h2.reset-target').first();
    // the editor brings the clicked field into view and the session goes on
    // when the page is scrolled, so scroll until the heading starts 20px below
    // the top of the frame: less than a bar of room above it
    await field.click();
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    const bar = chrome(page).locator(BAR);
    await expect(bar).toHaveAttribute('data-placement', 'above');
    await field.evaluate((element) => {
      scrollTo({
        top: element.getBoundingClientRect().top + scrollY - 20,
        behavior: 'instant',
      });
    });
    await expect(bar).toHaveAttribute('data-placement', 'below');
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    const barBox = await bar.boundingBox();
    const fieldBox = await field.boundingBox();
    if (barBox === null || fieldBox === null) throw new Error('No boxes');
    expect(
      Math.abs(barBox.y - (fieldBox.y + fieldBox.height + 8)),
    ).toBeLessThan(2);
  });
});
