/**
 * Editing rich text in place on the real page, in a real browser: one click on
 * a word selects the block and puts the caret there, typing edits the site's
 * own markup, the change is saved without a round trip for the field and
 * survives a reload, and the field leaves cleanly.
 */
import { expect, test, type Frame, type Locator } from '@playwright/test';
import {
  framedSite,
  HOST,
  openEditor,
  typeInField,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import { createEditablePage, section } from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';
const SAVING = 'Saving';
const SENTENCE = 'The quick brown fox jumps';

function paragraphDoc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** Opens a page holding one prose block with `text` in the editor. */
async function openProse(
  page: Parameters<typeof openEditor>[0],
  text = SENTENCE,
): Promise<{ frame: Frame; field: Locator }> {
  const created = await createEditablePage({
    blocks: [section({ type: 'prose', props: { body: paragraphDoc(text) } })],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return { frame, field: frame.locator('.prose-flow').first() };
}

/**
 * Where to click so the caret lands before the letter at `index` of the
 * field's first text node: a quarter of the way into that letter, which is
 * nearer to the boundary before it than to the one after.
 */
async function pointBefore(
  field: Locator,
  index: number,
): Promise<{ x: number; y: number }> {
  return await field.evaluate((element, at) => {
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
    );
    const node = walker.nextNode();
    if (node === null) throw new Error('The field holds no text');
    const range = element.ownerDocument.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const letter = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      x: letter.left + letter.width * 0.25 - box.left,
      y: letter.top + letter.height / 2 - box.top,
    };
  }, index);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test('one click on a word puts the caret there, typing edits the site markup, and the text is still there after a reload', async ({
  page,
}) => {
  const { field } = await openProse(page);
  // "The quick bro|wn fox jumps"
  const point = await pointBefore(field, SENTENCE.indexOf('wn'));
  await typeInField(page, field, 'X', point);

  // typing shows at once, in the host's own field element
  await expect(field.locator('p')).toHaveText('The quick broXwn fox jumps');
  // the pause after the last key, then the save
  await expect(page.getByText(SAVING, { exact: true })).toBeVisible();
  await expect(page.getByText(SAVED)).toBeVisible();

  await page.reload();
  const reloaded = await framedSite(page);
  await expect(reloaded.locator('.prose-block .prose-flow > p')).toHaveText(
    'The quick broXwn fox jumps',
  );
  await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
});
