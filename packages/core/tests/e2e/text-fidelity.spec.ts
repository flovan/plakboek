/**
 * Editing text in place must look and behave like the visitor page: the field
 * is edited in node views derived from the host's own renderers, so mounting
 * the editor moves nothing and the caret lands on the character that was
 * clicked. Paste keeps only what the theme allows, and says so when it
 * dropped something. Stored text the theme no longer allows is never mounted
 * (and so never silently rewritten); the editor chooses what happens to it.
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

type Doc = Readonly<Record<string, unknown>>;

function text(value: string): Doc {
  return { type: 'text', text: value };
}

function paragraph(value: string): Doc {
  return { type: 'paragraph', content: [text(value)] };
}

function item(value: string): Doc {
  return { type: 'listItem', content: [paragraph(value)] };
}

const RICH_BODY = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [text('A heading for the block')],
    },
    paragraph('The first paragraph is short.'),
    paragraph('The second paragraph has several words in it.'),
    { type: 'bulletList', content: [item('alpha item'), item('bravo item')] },
  ],
};

/** Opens a page holding one prose block with `body` in the editor. */
async function openProse(
  page: Parameters<typeof openEditor>[0],
  body: unknown = RICH_BODY,
): Promise<{ frame: Frame; field: Locator }> {
  const created = await createEditablePage({
    blocks: [section({ type: 'prose', props: { body } })],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return { frame, field: frame.locator('.prose-flow').first() };
}

/**
 * Where to click so the caret lands before the letter at `offset` of `word`:
 * a quarter of the way into that letter, nearer to the boundary before it
 * than to the one after. Relative to the element that holds the word.
 */
async function pointInWord(
  target: Locator,
  word: string,
  offset: number,
): Promise<{ x: number; y: number }> {
  return await target.evaluate(
    (element, args) => {
      const walker = element.ownerDocument.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
      );
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        const at = (node.textContent ?? '').indexOf(args.word);
        if (at === -1) continue;
        const range = element.ownerDocument.createRange();
        range.setStart(node, at + args.offset);
        range.setEnd(node, at + args.offset + 1);
        const letter = range.getBoundingClientRect();
        const holder = element.getBoundingClientRect();
        return {
          x: letter.left + letter.width * 0.25 - holder.left,
          y: letter.top + letter.height / 2 - holder.top,
        };
      }
      throw new Error(`"${args.word}" is not in the element`);
    },
    { word, offset },
  );
}

/** Every element of the field with its box relative to the field's own. */
async function layoutOf(field: Locator) {
  return await field.evaluate((element) => {
    const base = element.getBoundingClientRect();
    return [element, ...element.querySelectorAll('*')].map((node) => {
      const box = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        x: box.left - base.left,
        y: box.top - base.top,
        width: box.width,
        height: box.height,
      };
    });
  });
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('the field keeps the host styling while it is edited', () => {
  for (const scenario of [
    {
      name: 'a paragraph',
      holder: '.t-p >> nth=1',
      word: 'several',
      offset: 3,
      expected: 'The second paragraph has sevXeral words in it.',
    },
    {
      name: 'a list item',
      holder: '.t-li p >> nth=1',
      word: 'bravo',
      offset: 2,
      expected: 'brXavo item',
    },
  ]) {
    test(`${scenario.name}: nothing moves on mount and the caret lands in the clicked word`, async ({
      page,
    }) => {
      const { field } = await openProse(page);
      const before = await layoutOf(field);

      const holder = field.locator(scenario.holder);
      await typeInField(
        page,
        holder,
        '',
        await pointInWord(holder, scenario.word, scenario.offset),
      );

      const after = await layoutOf(field);
      expect(after.map((entry) => entry.tag)).toEqual(
        before.map((entry) => entry.tag),
      );
      for (const [index, entry] of before.entries()) {
        const now = after[index]!;
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          expect(
            Math.abs(now[key] - entry[key]),
            `${entry.tag} #${index} ${key}`,
          ).toBeLessThanOrEqual(1);
        }
      }

      await page.keyboard.type('X');
      await expect(field.locator('p', { hasText: 'X' })).toHaveText(
        scenario.expected,
      );
    });
  }
});

test('the host classes are still on the elements being edited', async ({
  page,
}) => {
  const { field } = await openProse(page);
  await typeInField(page, field.locator('.t-p').first(), '');
  await expect(field.locator('h2')).toHaveClass('t-h2');
  await expect(field.locator('ul')).toHaveClass('t-ul');
  await expect(field.locator('li').first()).toHaveClass('t-li');
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
});
