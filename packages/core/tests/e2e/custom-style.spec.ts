/**
 * Custom style on the real page, in a real browser: the toggle in the text
 * toolbar reveals Size, Color and Alignment for the selection, what is chosen
 * is stored as the theme's token or as a literal, and Reset style puts it all
 * back. Assertions are on what is stored and on the style values rendered, not
 * on how the browser resolves a CSS variable.
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
  doc: unknown = paragraphDoc('Colour this word'),
  type: 'prose' | 'brandProse' = 'prose',
): Promise<{ frame: Frame; field: Locator; pageId: string }> {
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type,
        props: { body: doc },
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

/** The stored document of the prose block, as text. */
async function storedBody(
  pageId: string,
  type: 'prose' | 'brandProse' = 'prose',
): Promise<string> {
  return JSON.stringify((await readBlockProps(pageId, type))['body']);
}

test('unlock, colour a word Accent: it is stored as a token and rendered through the theme', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  const toolbar = chrome(page).locator(TOOLBAR);
  await expect(toolbar).toBeVisible();

  // locked by default: no Size, Color or Alignment until Custom style is pressed
  const toggle = toolbar.getByRole('button', { name: 'Custom style' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(
    toolbar.getByRole('button', { name: /^Text color/ }),
  ).toHaveCount(0);

  // select the last word
  await page.keyboard.press('End');
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const colorButton = toolbar.getByRole('button', { name: /^Text color/ });
  await colorButton.click();
  const popover = toolbar.getByRole('dialog', { name: /^Text color/ });
  await expect(popover).toBeVisible();
  expect((await popover.boundingBox())?.width).toBe(320);
  await popover.getByRole('radio', { name: 'Accent' }).click();
  await expect(popover).toHaveCount(0);

  // the word carries the theme colour, and the field kept its focus
  await expect(field.locator('span[data-pk-color-token="accent"]')).toHaveText(
    'word',
  );
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Color set to Accent.',
  );

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect.poll(() => storedBody(pageId)).toContain('"token":"accent"');
  const stored = await storedBody(pageId);
  expect(stored).toContain('"textColor"');
  expect(stored).not.toContain('"value":"#');

  await page.reload();
  const reloaded = await framedSite(page);
  const word = reloaded.locator('.prose-flow span').filter({ hasText: 'word' });
  await expect(word).toHaveAttribute('style', /color:\s*var\(--color-accent\)/);
});

/** Opens the field, selects the last word and opens the Custom style row. */
async function unlockLastWord(
  page: Parameters<typeof openEditor>[0],
  field: Locator,
): Promise<Locator> {
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  const toolbar = chrome(page).locator(TOOLBAR);
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('End');
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await toolbar.getByRole('button', { name: 'Custom style' }).click();
  return toolbar;
}

test('a custom hex is stored literally, a size takes a token or a 20px literal, and a bad size is refused with the last value kept', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  const toolbar = await unlockLastWord(page, field);

  // hex colour
  await toolbar.getByRole('button', { name: /^Text color/ }).click();
  const colour = toolbar.getByRole('dialog', { name: /^Text color/ });
  await colour.getByLabel('Custom color').fill('#12ab34');
  await page.keyboard.press('Enter');
  await expect(colour).toHaveCount(0);
  await expect(field.locator('span[data-pk-color-value="#12ab34"]')).toHaveText(
    'word',
  );
  // the Color button now names the literal, and the dot says the text is custom
  await expect(
    toolbar.getByRole('button', { name: 'Text color: #12ab34' }),
  ).toBeVisible();
  await expect(toolbar.locator('[data-custom-dot]')).toBeVisible();

  // size by token, with the entry's label on the button
  await toolbar.getByRole('button', { name: /^Text size/ }).click();
  const size = toolbar.getByRole('dialog', { name: /^Text size/ });
  expect((await size.boundingBox())?.width).toBe(320);
  await expect(size.getByRole('radio')).toHaveText(['Theme default', 'Large']);
  await size.getByRole('radio', { name: 'Large' }).click();
  await expect(field.locator('span[data-pk-size-token="xl"]')).toHaveText(
    'word',
  );
  await expect(
    toolbar.getByRole('button', { name: 'Text size: Large' }),
  ).toBeVisible();
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Size set to Large.',
  );

  // a size out of range is refused, says why, and keeps the last valid value
  await toolbar.getByRole('button', { name: /^Text size/ }).click();
  const again = toolbar.getByRole('dialog', { name: /^Text size/ });
  await expect(again.getByText('Between 8 and 200 pixels.')).toBeVisible();
  await again.getByLabel('Custom size').fill('5');
  await page.keyboard.press('Enter');
  await expect(
    again.getByText('Enter a size between 8 and 200 pixels.'),
  ).toBeVisible();
  await expect(field.locator('span[data-pk-size-token="xl"]')).toHaveText(
    'word',
  );
  await expect(field.locator('span[data-pk-size-value]')).toHaveCount(0);

  // a valid px size is stored as a literal
  await again.getByLabel('Custom size').fill('20');
  await page.keyboard.press('Enter');
  await expect(again).toHaveCount(0);
  await expect(field.locator('span[data-pk-size-value="20px"]')).toHaveText(
    'word',
  );
  await expect(field.locator('span[data-pk-size-token]')).toHaveCount(0);

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect.poll(() => storedBody(pageId)).toContain('"value":"20px"');
  const stored = await storedBody(pageId);
  expect(stored).toContain('"value":"#12ab34"');
  expect(stored).not.toContain('"token":"xl"');
});

test('alignment applies to every paragraph the selection touches, and pressing the active one clears it', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page, {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
    ],
  });
  await field.click();
  const toolbar = chrome(page).locator(TOOLBAR);
  await toolbar.getByRole('button', { name: 'Custom style' }).click();
  await page.keyboard.press('ControlOrMeta+a');

  const centre = toolbar.getByRole('button', { name: 'Align center' });
  await expect(centre).toHaveAttribute('aria-pressed', 'false');
  await centre.click();
  await expect(centre).toHaveAttribute('aria-pressed', 'true');
  await expect(field.locator('p[style*="text-align: center"]')).toHaveCount(2);
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Alignment set to Center.',
  );

  await toolbar.getByRole('button', { name: 'Align right' }).click();
  await expect(field.locator('p[style*="text-align: right"]')).toHaveCount(2);
  // pressing the active alignment clears it back to the theme default
  await toolbar.getByRole('button', { name: 'Align right' }).click();
  await expect(field.locator('p[style*="text-align"]')).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'Align center' }).click();

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect
    .poll(async () => (await storedBody(pageId)).split('"center"').length - 1)
    .toBe(2);
});

test('Reset style strips colour, size and alignment in one undoable step and leaves bold alone', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page, {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold start', marks: [{ type: 'bold' }] },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
    ],
  });
  await field.click();
  const toolbar = chrome(page).locator(TOOLBAR);
  await toolbar.getByRole('button', { name: 'Custom style' }).click();
  const reset = toolbar.getByRole('button', { name: /^Reset style/ });
  // nothing custom yet: disabled, with its reason in the name
  await expect(reset).toHaveAttribute('aria-disabled', 'true');
  await expect(
    toolbar.getByRole('button', { name: 'Reset style, nothing to reset' }),
  ).toBeVisible();

  await page.keyboard.press('ControlOrMeta+a');
  await toolbar.getByRole('button', { name: /^Text color/ }).click();
  await toolbar
    .getByRole('dialog', { name: /^Text color/ })
    .getByRole('radio', { name: 'Accent' })
    .click();
  await toolbar.getByRole('button', { name: /^Text size/ }).click();
  await toolbar
    .getByRole('dialog', { name: /^Text size/ })
    .getByRole('radio', { name: 'Large' })
    .click();
  await toolbar.getByRole('button', { name: 'Align center' }).click();
  await expect(field.locator('[data-pk-color-token]')).toHaveCount(2);
  await expect(field.locator('[data-pk-size-token]')).toHaveCount(2);
  await expect(field.locator('p[style*="text-align: center"]')).toHaveCount(2);
  await expect(reset).not.toHaveAttribute('aria-disabled', 'true');

  await reset.click();
  await expect(
    field.locator('[data-pk-color],[data-pk-size],p[style*="text-align"]'),
  ).toHaveCount(0);
  await expect(field.locator('strong')).toHaveText('Bold start');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Style reset.',
  );
  await expect(reset).toHaveAttribute('aria-disabled', 'true');

  // one undo brings all three back
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field.locator('[data-pk-color-token]')).toHaveCount(2);
  await expect(field.locator('[data-pk-size-token]')).toHaveCount(2);
  await expect(field.locator('p[style*="text-align: center"]')).toHaveCount(2);

  // and the keyboard does the same thing
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(
    field.locator('[data-pk-color],[data-pk-size],p[style*="text-align"]'),
  ).toHaveCount(0);
  await expect(field.locator('strong')).toHaveText('Bold start');

  await toolbar.getByRole('button', { name: 'Done editing' }).click();
  await expect.poll(() => storedBody(pageId)).toContain('"bold"');
  const stored = await storedBody(pageId);
  for (const word of ['textColor', 'textSize', 'textAlign']) {
    expect(stored).not.toContain(word);
  }
});

test('with custom values off the swatches and sizes are there but no custom input is rendered', async ({
  page,
}) => {
  const { field } = await openProse(
    page,
    paragraphDoc('Colour this word'),
    'brandProse',
  );
  const toolbar = await unlockLastWord(page, field);

  await toolbar.getByRole('button', { name: /^Text color/ }).click();
  const colour = toolbar.getByRole('dialog', { name: /^Text color/ });
  await expect(colour.getByRole('radio', { name: 'Accent' })).toBeVisible();
  await expect(colour.getByLabel('Custom color')).toHaveCount(0);
  await expect(colour.locator('input')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(colour).toHaveCount(0);
  // Escape closed the popover only: the field session goes on
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');

  await toolbar.getByRole('button', { name: /^Text size/ }).click();
  const size = toolbar.getByRole('dialog', { name: /^Text size/ });
  await expect(size.getByRole('radio', { name: 'Large' })).toBeVisible();
  await expect(size.locator('input')).toHaveCount(0);
});
