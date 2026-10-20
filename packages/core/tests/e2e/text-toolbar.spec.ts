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
