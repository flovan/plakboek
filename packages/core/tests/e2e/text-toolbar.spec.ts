/**
 * The rich text toolbar on the real page, in a real browser: it floats pinned
 * to the field, formats the selection through its buttons and the keyboard,
 * and offers exactly what the property's theme allows. Assertions are on what
 * is stored and rendered, never on how the editor performs a command.
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

const TOOLBAR = '[data-text-toolbar]';

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
  text = 'Make this bold',
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

test('select the words, press Bold in the floating toolbar: it is saved bold and still bold after a reload', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');

  const toolbar = chrome(page).locator(TOOLBAR);
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute('role', 'toolbar');
  await expect(toolbar).toHaveAttribute('aria-label', /^Text formatting for /);
  // above the field, 8px clear of it, on its left edge
  await expect(toolbar).toHaveAttribute('data-placement', 'above');
  const barBox = await toolbar.boundingBox();
  const fieldBox = await field.boundingBox();
  if (barBox === null || fieldBox === null) throw new Error('No boxes');
  expect(Math.abs(barBox.y + barBox.height + 8 - fieldBox.y)).toBeLessThan(2);
  expect(Math.abs(barBox.x - fieldBox.x)).toBeLessThan(2);

  await page.keyboard.press('ControlOrMeta+a');
  const bold = toolbar.getByRole('button', { name: 'Bold' });
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  // the field kept the caret and the selection: the toolbar did not take focus
  await expect(field.locator('strong')).toHaveText('Make this bold');
  // the toolbar stays where it is while the selection moves inside the field
  await page.keyboard.press('ArrowLeft');
  await expect(toolbar).toBeVisible();
  const afterMove = await toolbar.boundingBox();
  expect(afterMove?.y).toBe(barBox.y);

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  await expect(toolbar).toHaveCount(0);
  await expect
    .poll(async () =>
      JSON.stringify((await readBlockProps(pageId, 'prose'))['body']),
    )
    .toContain('"bold"');

  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-flow strong')).toHaveText(
    'Make this bold',
  );
});

/** The stored document of the prose block, as text, once `expected` is in it. */
async function storedBody(pageId: string): Promise<string> {
  return JSON.stringify((await readBlockProps(pageId, 'prose'))['body']);
}

test('italic, underline and strikethrough work by shortcut and by button, and the toggles say what they did', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  const toolbar = chrome(page).locator(TOOLBAR);
  await page.keyboard.press('ControlOrMeta+a');

  const italic = toolbar.getByRole('button', { name: 'Italic' });
  const underline = toolbar.getByRole('button', { name: 'Underline' });
  const strike = toolbar.getByRole('button', { name: 'Strikethrough' });
  // shortcuts advertise themselves on the buttons
  await expect(italic).toHaveAttribute(
    'aria-keyshortcuts',
    /^(Control|Meta)\+I$/,
  );

  await page.keyboard.press('ControlOrMeta+i');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Italic on.',
  );
  await underline.click();
  await expect(underline).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await expect(strike).toHaveAttribute('aria-pressed', 'true');
  await expect(field.locator('em')).toHaveCount(1);
  await expect(field.locator('u')).toHaveCount(1);
  await expect(field.locator('s')).toHaveCount(1);

  // the same controls turn each mark off again
  await italic.click();
  await expect(italic).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Italic off.',
  );
  await page.keyboard.press('ControlOrMeta+u');
  await expect(underline).toHaveAttribute('aria-pressed', 'false');
  await strike.click();
  await expect(strike).toHaveAttribute('aria-pressed', 'false');
  await expect(field.locator('em, u, s')).toHaveCount(0);

  // and back on, so the saved document carries all three
  await italic.click();
  await underline.click();
  await strike.click();
  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect.poll(() => storedBody(pageId)).toContain('"strike"');
  const stored = await storedBody(pageId);
  expect(stored).toContain('"italic"');
  expect(stored).toContain('"underline"');
});

test('a bulleted list, then a numbered list, are stored and rendered', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await field.click();
  const toolbar = chrome(page).locator(TOOLBAR);
  await page.keyboard.press('ControlOrMeta+a');

  const bullets = toolbar.getByRole('button', { name: 'Bulleted list' });
  const numbers = toolbar.getByRole('button', { name: 'Numbered list' });
  await bullets.click();
  await expect(bullets).toHaveAttribute('aria-pressed', 'true');
  await expect(field.locator('ul > li')).toHaveText('Make this bold');
  await numbers.click();
  await expect(numbers).toHaveAttribute('aria-pressed', 'true');
  await expect(bullets).toHaveAttribute('aria-pressed', 'false');
  await expect(field.locator('ol > li')).toHaveText('Make this bold');
  await expect(field.locator('ul')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"orderedList"');
  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-flow ol > li')).toHaveText(
    'Make this bold',
  );
});

test('the Text style menu lists exactly four rows, chooses h2, h3 and h4, and h1 never exists', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await field.click();
  const toolbar = chrome(page).locator(TOOLBAR);
  await page.keyboard.press('ControlOrMeta+a');

  const button = toolbar.getByRole('button', { name: /^Text style, / });
  await expect(button).toHaveText('Paragraph');
  // the button is a fixed 112px, so no label ever truncates
  expect((await button.boundingBox())?.width).toBe(112);
  await button.click();
  const menu = toolbar.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Paragraph',
    'Title',
    'Heading',
    'Subheading',
  ]);
  await expect(
    menu.getByRole('menuitem', { name: 'Paragraph' }),
  ).toHaveAttribute('aria-current', 'true');
  expect((await menu.boundingBox())?.width).toBe(200);

  await menu.getByRole('menuitem', { name: 'Title' }).click();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveText('Title');
  await expect(field.locator('h2')).toHaveText('Make this bold');
  await expect.poll(() => storedBody(pageId)).toContain('"level":2');

  // by shortcut: Heading, then Subheading
  await page.keyboard.press('ControlOrMeta+Alt+3');
  await expect(button).toHaveText('Heading');
  await expect(field.locator('h3')).toHaveText('Make this bold');
  await expect.poll(() => storedBody(pageId)).toContain('"level":3');
  await page.keyboard.press('ControlOrMeta+Alt+4');
  await expect(button).toHaveText('Subheading');
  await expect(field.locator('h4')).toHaveText('Make this bold');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Subheading.',
  );
  // there is no h1 shortcut or row
  await page.keyboard.press('ControlOrMeta+Alt+1');
  await expect(field.locator('h1')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"level":4');
  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-flow h4')).toHaveText('Make this bold');
  await expect(reloaded.locator('h1')).toHaveCount(0);
});

test('a property narrowed to bold, italic and link shows exactly Bold, Italic and Done', async ({
  page,
}) => {
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'card',
        props: {
          title: 'A card',
          caption: paragraphDoc('Caption words'),
        },
      }),
    ],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  await frame.locator('.card-caption').click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');

  const toolbar = chrome(page).locator(TOOLBAR);
  const buttons = toolbar.getByRole('button');
  await expect(buttons).toHaveCount(3);
  await expect(buttons.nth(0)).toHaveAccessibleName('Bold');
  await expect(buttons.nth(1)).toHaveAccessibleName('Italic');
  await expect(buttons.nth(2)).toHaveAccessibleName('Done editing');
  await expect(
    toolbar.getByRole('button', { name: /^Text style/ }),
  ).toHaveCount(0);
});

test('the whole flow is done with the keyboard: Alt+F10 into the toolbar, arrows, Enter, Escape back to the field', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await page.keyboard.press('ControlOrMeta+a');
  const toolbar = chrome(page).locator(TOOLBAR);

  await page.keyboard.press('Alt+F10');
  // the toolbar's current control is the first one
  await expect(
    toolbar.getByRole('button', { name: /^Text style, / }),
  ).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const italic = toolbar.getByRole('button', { name: 'Italic' });
  await expect(italic).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toBeFocused();

  // Escape returns to the field with its selection, so typing replaces it
  await page.keyboard.press('Escape');
  await expect(field).toBeFocused();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await page.keyboard.type('Z');
  await expect(field).toHaveText('Z');

  // a second Escape ends the session
  await page.keyboard.press('Escape');
  await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  await expect.poll(() => storedBody(pageId)).toContain('"Z"');
});
