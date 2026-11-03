/**
 * Inserting structure into rich text on the real page, in a real browser: the
 * '/' menu, the toolbar's Insert menu and the toolbar fitting a narrow frame.
 * Assertions are on what is stored and rendered, not on how the editor works.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import {
  chrome,
  FRAME,
  framedSite,
  HOST,
  openEditor,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  paragraph,
  readBlockProps,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const TOOLBAR = '[data-text-toolbar]';
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
  // the field names the active menu item via aria-activedescendant while the menu is open
  await expect(field).toHaveAttribute('aria-activedescendant', /.+/);
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
    /^Button/,
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

test('Insert, Quote wraps the current paragraph in a blockquote that is stored and rendered', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page, 'A wise saying');
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  const toolbar = chrome(page).locator(TOOLBAR);

  const insert = toolbar.getByRole('button', { name: 'Insert' });
  await expect(insert).toHaveAttribute('aria-haspopup', 'menu');
  await insert.click();
  const menu = toolbar.getByRole('menu', { name: 'Insert' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Button',
    'Quote',
    'Divider',
  ]);
  expect((await menu.boundingBox())?.width).toBe(200);
  await menu.getByRole('menuitem', { name: 'Quote' }).click();
  await expect(menu).toHaveCount(0);
  await expect(field.locator('blockquote')).toHaveText('A wise saying');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Quote.',
  );

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect.poll(() => storedBody(pageId)).toContain('"blockquote"');
  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-flow blockquote')).toHaveText(
    'A wise saying',
  );
});

test('Insert, Divider puts a rule on its own line and keeps a paragraph after it', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page, 'Before the rule');
  await startSecondParagraph(page, field);
  const toolbar = chrome(page).locator(TOOLBAR);

  await toolbar.getByRole('button', { name: 'Insert' }).click();
  await toolbar
    .getByRole('menu', { name: 'Insert' })
    .getByRole('menuitem', { name: 'Divider' })
    .click();
  await expect(field.locator('hr')).toHaveCount(1);
  // the caret is in a paragraph after the rule: typing lands there
  await page.keyboard.type('After the rule');
  await expect(field.locator('hr + p')).toHaveText('After the rule');

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"horizontalRule"');
  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-flow hr + p')).toHaveText(
    'After the rule',
  );
});

test('at a 1024px window the toolbar fits inside the frame with everything on the bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  const { field } = await openProse(page);
  await field.click();
  const toolbar = chrome(page).locator(TOOLBAR);
  await expect(toolbar).toBeVisible();
  const frameBox = await page.locator(FRAME).boundingBox();
  const barBox = await toolbar.boundingBox();
  if (frameBox === null || barBox === null) throw new Error('No boxes');
  expect(barBox.width).toBeLessThanOrEqual(frameBox.width - 16);
  expect(barBox.x).toBeGreaterThanOrEqual(frameBox.x);
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(
    frameBox.x + frameBox.width,
  );
  // nothing needs to move yet, and Done keeps its text
  await expect(
    toolbar.getByRole('button', { name: 'Strikethrough' }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole('button', { name: 'More formatting' }),
  ).toHaveCount(0);
  await expect(
    toolbar.getByRole('button', { name: 'Done editing' }),
  ).toHaveText('Done');
});

test('in a frame narrower than the bar Done goes icon-only and Strikethrough, Underline and the lists move into More, which still works', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page, 'Narrow words');
  await field.click();
  const toolbar = chrome(page).locator(TOOLBAR);
  await expect(toolbar).toBeVisible();
  // the windows this editor supports leave the bar room to spare, so the
  // frame itself is made narrower than the bar (the Custom style label and
  // Link never collapse, so 500px is about the narrowest that still holds it)
  await page.locator(FRAME).evaluate((frame) => {
    frame.style.width = '500px';
  });
  const more = toolbar.getByRole('button', { name: 'More formatting' });
  await expect(more).toBeVisible();
  const frameBox = await page.locator(FRAME).boundingBox();
  const barBox = await toolbar.boundingBox();
  if (frameBox === null || barBox === null) throw new Error('No boxes');
  expect(barBox.width).toBeLessThanOrEqual(frameBox.width - 16);

  // Done keeps its name and loses its text; Text style and Bold never move
  await expect(
    toolbar.getByRole('button', { name: 'Done editing' }),
  ).toHaveText('');
  await expect(
    toolbar.getByRole('button', { name: /^Text style, / }),
  ).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toBeVisible();
  await expect(
    toolbar.getByRole('button', { name: 'Strikethrough' }),
  ).toHaveCount(0);

  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await page.keyboard.press('ControlOrMeta+a');
  await more.click();
  const menu = toolbar.getByRole('menu', { name: 'More formatting' });
  const strike = menu.getByRole('menuitemcheckbox', { name: 'Strikethrough' });
  await expect(strike).toHaveAttribute('aria-checked', 'false');
  await strike.click();
  await expect(menu).toHaveCount(0);
  await expect(field.locator('s')).toHaveText('Narrow words');
  await more.click();
  await expect(
    toolbar
      .getByRole('menu', { name: 'More formatting' })
      .getByRole('menuitemcheckbox', { name: 'Strikethrough' }),
  ).toHaveAttribute('aria-checked', 'true');
  // pressing More again closes the menu
  await more.click();
  await expect(menu).toHaveCount(0);

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect.poll(() => storedBody(pageId)).toContain('"strike"');
});
