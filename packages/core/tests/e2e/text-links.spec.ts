/**
 * Links in rich text on the real page, in a real browser: the toolbar's Link
 * button opens a popover that links the selection to a web address, the link
 * is stored with exactly the target that was chosen and is rendered on the
 * page after a reload, and an address the href policy refuses cannot become a
 * link. Assertions are on what is stored and rendered, never on how the
 * editor builds its marks.
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
const POPOVER = '[data-link-popover]';

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
  text = 'Read our story today',
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

/** The stored document of the prose block, as text. */
async function storedBody(pageId: string): Promise<string> {
  return JSON.stringify((await readBlockProps(pageId, 'prose'))['body']);
}

/** Selects the two words "our story" of the opened field. */
async function selectOurStory(
  page: Parameters<typeof openEditor>[0],
  field: Locator,
): Promise<void> {
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 9; i += 1) await page.keyboard.press('Shift+ArrowRight');
}

test('select two words, link them to a web address: stored with that address, rendered as an anchor after a reload', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);

  const toolbar = chrome(page).locator(TOOLBAR);
  const linkButton = toolbar.getByRole('button', { name: 'Link' });
  await expect(linkButton).toHaveAttribute('aria-pressed', 'false');
  await linkButton.click();

  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('role', 'dialog');
  await expect(popover).toHaveAccessibleName('Link');
  expect((await popover.boundingBox())?.width).toBe(320);

  const address = popover.getByLabel('Web address');
  await expect(address).toBeFocused();
  await address.fill('https://example.com');
  await popover.getByRole('button', { name: 'Apply link' }).click();

  // the popover is gone, the field kept its focus, the words are linked
  await expect(popover).toHaveCount(0);
  await expect(field.locator('a')).toHaveText('our story');
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toHaveText(
    'Link added.',
  );
  // the selection still covers the link, so the button reads as in a link
  await expect(linkButton).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(linkButton).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"link"');
  const stored = JSON.parse(await storedBody(pageId)) as {
    content: { content: { text: string; marks?: unknown[] }[] }[];
  };
  const linked = stored.content[0]?.content.find((run) => run.marks?.length);
  expect(linked?.text).toBe('our story');
  expect(linked?.marks).toEqual([
    {
      type: 'link',
      attrs: { href: 'https://example.com', pageId: null, target: null },
    },
  ]);

  await page.reload();
  const reloaded = await framedSite(page);
  const anchor = reloaded.locator('.prose-flow a');
  await expect(anchor).toHaveText('our story');
  await expect(anchor).toHaveAttribute('href', 'https://example.com');
});

test('a script address shows the web address error and cannot be applied', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page);
  await selectOurStory(page, field);
  await chrome(page)
    .locator(TOOLBAR)
    .getByRole('button', { name: 'Link' })
    .click();

  const popover = chrome(page).locator(POPOVER);
  const address = popover.getByLabel('Web address');
  await address.fill('javascript:alert(1)');
  await address.blur();
  await expect(popover.getByRole('alert')).toHaveText(
    'Enter a web address like https://example.com, or an email or phone link.',
  );

  const apply = popover.getByRole('button', { name: 'Apply link' });
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  // an aria-disabled button is still pressable, and a press does nothing
  await apply.click({ force: true });
  // nothing was linked and the popover is still open for another try
  await expect(field.locator('a')).toHaveCount(0);
  await expect(popover).toBeVisible();

  // Escape closes without a change and returns to the field
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field.locator('a')).toHaveCount(0);
  expect(await storedBody(pageId)).not.toContain('"link"');
});
