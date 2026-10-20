/**
 * Inserting structure into rich text on the real page, in a real browser: the
 * '/' menu, the toolbar's Insert menu and the toolbar fitting a narrow frame.
 * Assertions are on what is stored and rendered, not on how the editor works.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import { chrome, framedSite, HOST, openEditor } from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  paragraph,
  readBlockProps,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SLASH = '[data-slash-menu]';

function paragraphDoc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

/** Opens a page with a prose block under an intro that gives the toolbar room above. */
async function openProse(
  page: Parameters<typeof openEditor>[0],
  text = 'First line',
): Promise<{ frame: Frame; field: Locator; pageId: string }> {
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'prose',
        props: { body: paragraphDoc(text) },
      }),
    ],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return {
    frame,
    field: frame.locator('.prose-flow').first(),
    pageId: created.pageId,
  };
}

async function storedBody(pageId: string): Promise<string> {
  return JSON.stringify((await readBlockProps(pageId, 'prose'))['body']);
}

/** Starts editing the field with the caret in a new, empty second paragraph. */
async function startSecondParagraph(
  page: Parameters<typeof openEditor>[0],
  field: Locator,
): Promise<void> {
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
}

test('type /sub and press Enter: the line becomes a Subheading, nothing of the slash is left, and it is stored after a reload', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await startSecondParagraph(page, field);

  await page.keyboard.type('/sub');
  const menu = chrome(page).locator(SLASH);
  await expect(menu).toBeVisible();
  // the field keeps the caret: the menu takes no focus
  await expect(menu.getByRole('option')).toHaveText([/^Subheading/]);
  await expect(menu.getByRole('listbox')).toHaveAttribute(
    'aria-activedescendant',
    /.+/,
  );
  expect((await menu.boundingBox())?.width).toBe(320);

  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(field.locator('h4')).toHaveCount(1);
  await expect(field).not.toContainText('/sub');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Subheading.',
  );
  // and typing goes on inside the new heading
  await page.keyboard.type('Second');
  await expect(field.locator('h4')).toHaveText('Second');

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"level":4');
  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-flow h4')).toHaveText('Second');
  await expect(reloaded.locator('.prose-flow p').first()).toHaveText(
    'First line',
  );
});

test('a lone slash opens the full list in order; Escape closes it and keeps the slash as text', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await startSecondParagraph(page, field);

  await page.keyboard.type('/');
  const menu = chrome(page).locator(SLASH);
  await expect(menu.getByRole('option')).toHaveText([
    /^Paragraph/,
    /^Title/,
    /^Heading/,
    /^Subheading/,
    /^Bulleted list/,
    /^Numbered list/,
    /^Quote/,
    /^Divider/,
  ]);
  await expect(menu.getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('option').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // the session goes on and the slash is still there
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field).toContainText('/');
});

test('no match says so, a space closes the menu, and a slash inside a word never opens it', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await startSecondParagraph(page, field);

  await page.keyboard.type('/zzz');
  const menu = chrome(page).locator(SLASH);
  await expect(menu).toContainText('No matching items.');
  await expect(menu.getByRole('option')).toHaveCount(0);
  await page.keyboard.type(' ');
  await expect(menu).toHaveCount(0);
  await expect(field).toContainText('/zzz');

  await page.keyboard.type('a/b');
  await expect(menu).toHaveCount(0);
});
