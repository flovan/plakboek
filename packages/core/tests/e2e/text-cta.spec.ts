/**
 * A call-to-action button inside a text flow, on the real page, in a real
 * browser: inserted from the toolbar or the '/' menu, kept between paragraphs
 * in the same field, edited in its popover, and rendered after a reload
 * through the host's own button renderer. Assertions are on what is stored and
 * rendered, never on how the editor builds its nodes.
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
