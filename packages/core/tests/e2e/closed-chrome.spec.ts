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

function tag(): string {
  return Math.random().toString(36).slice(2, 8);
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

/** Selects the first run of text that holds `words`, the way a drag over them would. */
async function selectWords(
  frame: Frame,
  field: Locator,
  words: string,
): Promise<void> {
  await field.evaluate((element, wanted) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const at = (node.textContent ?? '').indexOf(wanted);
      if (at !== -1) {
        window
          .getSelection()
          ?.setBaseAndExtent(node, at, node, at + wanted.length);
        return;
      }
    }
    throw new Error(`No text holds ${wanted}`);
  }, words);
  // the editor learns of the selection from the browser's own event, a task later
  await expect
    .poll(() => frame.evaluate(() => String(window.getSelection())))
    .toBe(words);
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

test('Insert menu by pointer: pressing Quote turns the empty paragraph into a quote', async ({
  page,
}) => {
  const { field } = await openProse(page, 'First line');
  await startField(page, field);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');

  await clickFrameChrome(page, '[data-menu-button="insert"]');
  await clickFrameChrome(page, '[data-insert-item]', 'Quote');
  await expect(field.locator('blockquote')).toHaveCount(1);
});

test('link popover by pointer: the Web address segment and input, then a page row, act inside the popover', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Team ${word}`,
    blocks: [],
  });
  const { frame, field, pageId } = await openProse(
    page,
    'Read our story today',
  );
  await startField(page, field);
  await selectWords(frame, field, 'our story');

  await clickFrameChrome(page, '[data-link-button]');
  await expectChrome(page, '[data-link-popover]', 1);
  await clickFrameChrome(page, '[data-segment="web"]');
  await expectChrome(page, '[data-link-popover]', 1);
  await expectChrome(page, '[data-link-input="web"]', 1);
  await clickFrameChrome(page, '[data-link-input="web"]');
  await page.keyboard.type('https://example.com');
  await page.keyboard.press('Enter');
  await expect(field.locator('a[href="https://example.com"]')).toHaveText(
    'our story',
  );

  // a second link, to a page, picked by its row
  await selectWords(frame, field, 'today');
  await clickFrameChrome(page, '[data-link-button]');
  await expectChrome(page, '[data-link-popover]', 1);
  await clickFrameChrome(page, '[data-link-input="page"]');
  await page.keyboard.type(word);
  await clickFrameChrome(page, `[data-page-id="${target.pageId}"]`);
  await expectChrome(page, '[data-link-popover]', 1);
  await clickFrameChrome(page, '[data-link-popover] button', 'Apply link');
  await expectChrome(page, '[data-link-popover]', 0);

  await page.keyboard.press('Escape');
  await expect.poll(() => storedBody(pageId)).toContain(target.pageId);
});

test('Custom style by pointer: a size row, the custom size input and a colour swatch apply and keep their popovers open until pressed outside', async ({
  page,
}) => {
  const { frame, field } = await openProse(page, 'Colour this word');
  await startField(page, field);
  await selectWords(frame, field, 'word');

  await clickFrameChrome(page, '[data-custom-toggle]');
  await clickFrameChrome(page, '[data-popover-button="size"]');
  await expectChrome(page, '[data-popover="size"]', 1);
  await clickFrameChrome(page, '[data-size-row="xl"]');
  await expect(field.locator('span[data-pk-size-token="xl"]')).toHaveText(
    'word',
  );

  await clickFrameChrome(page, '[data-popover-button="size"]');
  await expectChrome(page, '[data-popover="size"]', 1);
  await clickFrameChrome(page, '[data-custom-input="size"]');
  await expectChrome(page, '[data-popover="size"]', 1);
  await page.keyboard.type('20');
  await expect(field.locator('span[data-pk-size-value="20px"]')).toHaveText(
    'word',
  );
  // a press on the text of the field is outside the popover
  await field.click({ position: { x: 4, y: 4 } });
  await expectChrome(page, '[data-popover="size"]', 0);

  await selectWords(frame, field, 'word');
  await clickFrameChrome(page, '[data-popover-button="color"]');
  await expectChrome(page, '[data-popover="color"]', 1);
  await clickFrameChrome(page, '[data-swatch="accent"]');
  await expect(field.locator('span[data-pk-color-token="accent"]')).toHaveText(
    'word',
  );
});

test('Button block by pointer: a press in the Label input of its popover edits the label and leaves the popover open', async ({
  page,
}) => {
  const { frame } = await open(page, [
    section(paragraph('Intro '.repeat(60)), {
      type: 'button',
      props: { label: 'Book', variant: 'primary' },
    }),
  ]);
  const cta = frame.locator('.button-block .t-cta');
  await cta.click();
  await expectChrome(page, '[data-button-popover]', 1);

  await clickFrameChrome(page, '[data-button-label]');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Book now');
  await expectChrome(page, '[data-button-popover]', 1);
  await expect(cta).toHaveText('Book now');
});
