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
  type: 'prose' | 'strictText' = 'prose',
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
  type: 'prose' | 'strictText' = 'prose',
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
