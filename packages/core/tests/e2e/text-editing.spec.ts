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
  selectedId,
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

test.describe('leaving a field', () => {
  test('Escape ends the session, the block stays selected and the field is the site markup again', async ({
    page,
  }) => {
    const { field } = await openProse(page);
    const before = await field.evaluate((element) => element.outerHTML);

    await typeInField(page, field, '', await pointBefore(field, 4));
    const id = await selectedId(page);
    expect(id).not.toBeNull();
    // the field itself is the editing surface: no wrapper, its classes kept
    await expect(field).toHaveAttribute('contenteditable', 'true');
    await expect(field).toHaveClass(/prose-flow/);
    await expect(field).toHaveAttribute('data-pk-field', 'body');

    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    // Escape ended the field only: the block is still selected
    expect(await selectedId(page)).toBe(id);
    // nothing was typed, so the field is exactly what the server rendered
    expect(await field.evaluate((element) => element.outerHTML)).toBe(before);
  });

  test('adds no stylesheet to the framed site while a field is edited', async ({
    page,
  }) => {
    const { frame, field } = await openProse(page);
    const styles = (): Promise<number> =>
      frame.evaluate(() => document.querySelectorAll('style').length);
    const before = await styles();
    await typeInField(page, field, 'a');
    expect(await styles()).toBe(before);
  });

  test('a click on another block saves the pending text before selecting it', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(
          { type: 'prose', props: { body: paragraphDoc('First block') } },
          { type: 'prose', props: { body: paragraphDoc('Second block') } },
        ),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const first = frame.locator('.prose-flow').nth(0);
    const second = frame.locator('.prose-flow').nth(1);

    await typeInField(page, first, '!');
    // straight away, inside the pause before the autosave
    await second.locator('p').click();
    await expect(first.locator('p')).toHaveText('First block!');
    expect(await selectedId(page)).toBe(
      await second.evaluate(
        (element) =>
          element.closest('[data-pk-block]')?.getAttribute('data-pk-block') ??
          null,
      ),
    );
    await expect(page.getByText(SAVED)).toBeVisible();

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(
      reloaded.locator('.prose-flow').nth(0).locator('p'),
    ).toHaveText('First block!');
  });

  test('a double-click inside the active field selects a word and keeps the session', async ({
    page,
  }) => {
    const { frame, field } = await openProse(page);
    await typeInField(page, field, '', await pointBefore(field, 0));
    const id = await selectedId(page);

    const inside = await pointBefore(field, SENTENCE.indexOf('quick') + 2);
    await field.dblclick({ position: inside });
    await expect
      .poll(() => frame.evaluate(() => document.getSelection()?.toString()))
      .toBe('quick');
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    expect(await selectedId(page)).toBe(id);
  });

  test('the sidebar Undo ends the session and undoes the whole typing burst as one step', async ({
    page,
  }) => {
    const { field } = await openProse(page);
    await typeInField(page, field, 'ABC', await pointBefore(field, 0));
    await expect(field.locator('p')).toHaveText(`ABC${SENTENCE}`);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    await expect(field.locator('p')).toHaveText(SENTENCE);
    await expect(page.getByText(SAVED)).toBeVisible();
  });
});
