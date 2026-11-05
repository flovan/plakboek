/**
 * A call-to-action button inside a text flow, on the real page, in a real
 * browser: inserted from the toolbar or the '/' menu, kept between paragraphs
 * in the same field, edited in its popover, and rendered after a reload
 * through the host's own button renderer. Assertions are on what is stored and
 * rendered, never on how the editor builds its nodes.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import {
  chrome,
  framedSite,
  HOST,
  openEditor,
  selectItem,
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
const POPOVER = '[data-button-popover]';

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
  text = 'First sentence.',
): Promise<{ frame: Frame; field: Locator; pageId: string; path: string }> {
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
    path: created.path,
  };
}

/** The stored document of the prose block. */
async function storedDoc(pageId: string): Promise<{
  content: { type: string; attrs?: Record<string, unknown> }[];
}> {
  return (await readBlockProps(pageId, 'prose'))['body'] as {
    content: { type: string; attrs?: Record<string, unknown> }[];
  };
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

/** The kinds of the field's children, in order: `p`, `button`, `h` ... */
async function shape(field: Locator): Promise<string[]> {
  return await field.evaluate((element) =>
    [...element.children].map((child) =>
      child.querySelector('.t-cta') !== null || child.matches('.t-cta')
        ? 'button'
        : child.tagName.toLowerCase(),
    ),
  );
}

test('type, Enter, insert a Button, keep typing below it in the same field: stored in order and rendered through the host after a reload', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await startSecondParagraph(page, field);
  const toolbar = chrome(page).locator(TOOLBAR);

  await toolbar.getByRole('button', { name: 'Insert' }).click();
  await toolbar
    .getByRole('menu', { name: 'Insert' })
    .getByRole('menuitem', { name: 'Button' })
    .click();

  // the button sits in the flow, drawn by the host's renderer, and its popover
  // is open on the Label with the default text selected
  await expect(field.locator('.t-cta')).toHaveText('Button');
  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAccessibleName('Button');
  const label = popover.getByLabel('Label');
  await expect(label).toBeFocused();
  expect(
    await label.evaluate((input: HTMLInputElement) =>
      input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
    ),
  ).toBe('Button');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Button added.',
  );

  // Escape closes the popover, the field has the focus, and typing goes on
  // in the paragraph kept below the button
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Second sentence.');
  await expect(field.locator('p').last()).toHaveText('Second sentence.');
  expect(await shape(field)).toEqual(['p', 'button', 'p']);

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await storedDoc(pageId)).content.map((n) => n.type))
    .toEqual(['paragraph', 'cta', 'paragraph']);
  expect((await storedDoc(pageId)).content[1]?.attrs).toEqual({
    label: 'Button',
    href: null,
    pageId: null,
    target: null,
    variant: 'primary',
  });

  await page.reload();
  const reloaded = (await framedSite(page)).locator('.prose-flow');
  expect(await shape(reloaded)).toEqual(['p', 'button', 'p']);
  await expect(reloaded.locator('p').last()).toHaveText('Second sentence.');
  await expect(reloaded.locator('.t-cta')).toHaveText('Button');
});

/** Inserts a Button from the toolbar's Insert menu. */
async function insertButton(
  page: Parameters<typeof openEditor>[0],
): Promise<void> {
  const toolbar = chrome(page).locator(TOOLBAR);
  await toolbar.getByRole('button', { name: 'Insert' }).click();
  await toolbar
    .getByRole('menu', { name: 'Insert' })
    .getByRole('menuitem', { name: 'Button' })
    .click();
}

/** A unique word, so a search finds one page of the shared database. */
function tag(): string {
  return `zq${Math.random().toString(36).slice(2, 8)}`;
}

test('change the label and the style and link it to a page: stored with all three and rendered with the label, the variant and the page path after a reload', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Team ${word}`,
    blocks: [],
  });
  const { field, pageId } = await openProse(page);
  await startSecondParagraph(page, field);
  await insertButton(page);

  const popover = chrome(page).locator(POPOVER);
  // the label is applied as it is typed
  await popover.getByLabel('Label').fill('Read more');
  await expect(field.locator('.t-cta')).toHaveText('Read more');
  // the style is a segmented control of the theme's variants
  const styles = popover.getByRole('radiogroup', { name: 'Style' });
  await expect(styles.getByRole('radio')).toHaveText(['Primary', 'Secondary']);
  await expect(styles.getByRole('radio', { name: 'Primary' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await styles.getByRole('radio', { name: 'Secondary' }).click();
  await expect(field.locator('.t-cta')).toHaveAttribute(
    'data-variant',
    'secondary',
  );
  // the link is the shared section, applied once valid
  await popover.getByLabel('Search pages').fill(word);
  await popover.getByRole('option', { name: `Team ${word}` }).click();
  await popover.getByRole('button', { name: 'Done' }).click();
  await expect(popover).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await storedDoc(pageId)).content[1]?.attrs)
    .toEqual({
      label: 'Read more',
      href: null,
      pageId: target.pageId,
      target: null,
      variant: 'secondary',
    });

  await page.reload();
  const cta = (await framedSite(page)).locator('.prose-flow .t-cta');
  await expect(cta).toHaveText('Read more');
  await expect(cta).toHaveAttribute('data-variant', 'secondary');
  await expect(cta).toHaveAttribute('href', target.path);
});

test('two adjacent buttons share one row in the field and on the page', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await startSecondParagraph(page, field);
  await insertButton(page);
  await page.keyboard.press('Escape');
  await insertButton(page);
  await page.keyboard.press('Escape');

  await expect(field.locator('.t-cta')).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await storedDoc(pageId)).content.map((n) => n.type))
    .toEqual(['paragraph', 'cta', 'cta', 'paragraph']);
  await page.reload();
  const reloaded = (await framedSite(page)).locator('.prose-flow');
  await expect(reloaded.locator('.t-cta-row')).toHaveCount(1);
  await expect(reloaded.locator('.t-cta-row .t-cta')).toHaveCount(2);
});

test('a button with no link says it needs one while selected, and is absent from the visitor page with its data kept', async ({
  page,
  request,
}) => {
  const created = await createEditablePage({
    publish: true,
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'prose',
        props: {
          body: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
              {
                type: 'cta',
                attrs: {
                  label: 'Go',
                  href: null,
                  pageId: null,
                  target: null,
                  variant: 'primary',
                },
              },
              { type: 'paragraph', content: [{ type: 'text', text: 'Bye' }] },
            ],
          },
        },
      }),
    ],
  });

  // a visitor sees the text and not the unfinished button
  const visitor = await (await request.get(created.path)).text();
  expect(visitor).toContain('Hello');
  expect(visitor).toContain('Bye');
  expect(visitor).not.toContain('t-cta');

  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const field = frame.locator('.prose-flow').first();
  // the editor still draws it, and the block being selected marks it
  await expect(field.locator('.t-cta')).toHaveText('Go');
  await selectItem(page, field.locator('p').first());
  const marker = chrome(page).locator('[data-cta-marker]');
  await expect(marker).toHaveText('Needs a link');
  // decoration: hidden from assistive technology, the popover says it in text
  await expect(chrome(page).locator('[data-cta-decor]')).toHaveAttribute(
    'aria-hidden',
    'true',
  );

  // while the field is edited and the button selected, the popover says it in text
  await field.locator('p').first().click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(marker).toHaveText('Needs a link');
  await field.locator('.t-cta').click();
  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover.locator('[data-button-needs]')).toHaveText(
    'Needs a link',
  );
  expect((await readBlockProps(created.pageId, 'prose'))['body']).toBeDefined();
});

test('an empty label shows its error and the marker, and is kept', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await startSecondParagraph(page, field);
  await insertButton(page);
  const popover = chrome(page).locator(POPOVER);
  await popover.getByLabel('Label').fill('');
  await expect(popover.getByRole('alert')).toHaveText(
    'Enter a label for the button.',
  );
  await expect(chrome(page).locator('[data-cta-marker]')).toHaveText(
    'Needs a label',
  );
  await popover.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await storedDoc(pageId)).content[1]?.attrs?.['label'])
    .toBe('');
});

test('while a button is selected every control but Insert and Done is not available', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await startSecondParagraph(page, field);
  await insertButton(page);
  const toolbar = chrome(page).locator(TOOLBAR);

  const bold = toolbar.getByRole('button', {
    name: 'Bold, not available for a button',
  });
  await expect(bold).toHaveAttribute('aria-disabled', 'true');
  for (const name of ['Italic', 'Link', 'Text style', 'Custom style']) {
    await expect(
      toolbar.getByRole('button', {
        name: new RegExp(`^${name}.*not available for a button$`),
      }),
    ).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(
    toolbar.getByRole('button', { name: 'Insert' }),
  ).not.toHaveAttribute('aria-disabled', 'true');
  await expect(
    toolbar.getByRole('button', { name: 'Done editing' }),
  ).not.toHaveAttribute('aria-disabled', 'true');

  // a press does nothing to the text; it leaves the button, the focus in the field
  await bold.click({ force: true });
  await expect(chrome(page).locator(POPOVER)).toHaveCount(0);
  await expect(field.locator('strong')).toHaveCount(0);

  // moving the caret below the button makes the controls available again
  await page.keyboard.press('ArrowDown');
  await expect(
    toolbar.getByRole('button', { name: 'Bold', exact: true }),
  ).not.toHaveAttribute('aria-disabled', 'true');
});

test('a label is refused past 200 characters and the stored label keeps all 200', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await startSecondParagraph(page, field);
  await insertButton(page);

  const popover = chrome(page).locator(POPOVER);
  const label = popover.getByLabel('Label');
  await label.fill('word '.repeat(60));
  expect(await label.inputValue()).toHaveLength(200);

  const cta = field.locator('.t-cta');
  await expect(cta).toHaveText('word '.repeat(40).trim());

  await popover.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => {
      const label = (await storedDoc(pageId)).content[1]?.attrs?.['label'];
      return typeof label === 'string' ? label.length : 0;
    })
    .toBe(200);
});

test('Remove button deletes it and says so, Control+Z brings it back, and Backspace removes a selected button', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await startSecondParagraph(page, field);
  await insertButton(page);
  const popover = chrome(page).locator(POPOVER);

  await popover.getByRole('button', { name: 'Remove button' }).click();
  await expect(popover).toHaveCount(0);
  await expect(field.locator('.t-cta')).toHaveCount(0);
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Button removed.',
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field.locator('.t-cta')).toHaveCount(1);

  // a click selects it and opens the popover again; Escape leaves it selected
  await field.locator('.t-cta').click();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await expect(field.locator('.t-cta')).toHaveCount(0);
  expect(await shape(field)).toEqual(['p', 'p']);
});

test('the slash menu inserts a Button and Enter after a selected button starts a paragraph below', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await startSecondParagraph(page, field);
  await page.keyboard.type('/but');
  await page.keyboard.press('Enter');
  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(field).not.toContainText('/but');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed below');
  expect(await shape(field)).toEqual(['p', 'button', 'p', 'p']);
  await expect(field.locator('p').nth(1)).toHaveText('Typed below');
});
