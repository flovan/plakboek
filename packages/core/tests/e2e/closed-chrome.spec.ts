/**
 * The in-frame text popovers and menus with the product's closed chrome root,
 * in a real browser. The other text specs open the root so Playwright can
 * reach inside it; here it stays closed and every control is pressed by its
 * coordinates, so a press inside a popover takes the path a real editor's
 * press takes. A popover that counted such a press as a press outside it would
 * close before the click landed. Assertions are on what the field holds and
 * what is stored.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import {
  clickFrameChrome,
  frameChromeCount,
  frameChromeIsClosed,
  framedSite,
  holdFrameChrome,
  HOST,
  openEditor,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  paragraph,
  readBlockProps,
  section,
  type FactoryBlock,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

type Page = Parameters<typeof openEditor>[0];

function paragraphDoc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

/** Opens a page with the closed chrome root; its chrome is reached by coordinates only. */
async function open(
  page: Page,
  blocks: readonly FactoryBlock[],
): Promise<{ frame: Frame; pageId: string }> {
  const created = await createEditablePage({ blocks });
  await holdFrameChrome(page);
  await openEditor(page, created.path, { exposeChrome: false });
  await expect.poll(() => frameChromeIsClosed(page)).toBe(true);
  return { frame: await framedSite(page), pageId: created.pageId };
}

/** A prose block under an intro that gives the toolbar room above. */
async function openProse(
  page: Page,
  text: string,
): Promise<{ frame: Frame; field: Locator; pageId: string }> {
  const { frame, pageId } = await open(page, [
    section(paragraph('Intro '.repeat(60)), {
      type: 'prose',
      props: { body: paragraphDoc(text) },
    }),
  ]);
  return { frame, field: frame.locator('.prose-flow').first(), pageId };
}

async function storedBody(pageId: string): Promise<string> {
  return JSON.stringify((await readBlockProps(pageId, 'prose'))['body']);
}

async function startField(page: Page, field: Locator): Promise<void> {
  await field.click();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await expect(field).toBeFocused();
}

/** Waits until `selector` is (or is no longer) under the closed chrome root. */
async function expectChrome(
  page: Page,
  selector: string,
  count: number,
): Promise<void> {
  await expect.poll(() => frameChromeCount(page, selector)).toBe(count);
}

test('Text style by pointer: pressing Title in the menu converts the paragraph and the menu does not close on the press', async ({
  page,
}) => {
  const { field, pageId } = await openProse(page, 'Make this bold');
  await startField(page, field);
  await page.keyboard.press('ControlOrMeta+a');

  await clickFrameChrome(page, '[data-style-button]');
  await expectChrome(page, '[data-style-menu]', 1);
  await clickFrameChrome(page, '[role="menuitem"]', 'Title');
  await expect(field.locator('h2')).toHaveText('Make this bold');
  await expectChrome(page, '[data-style-menu]', 0);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain('"level":2');
});
