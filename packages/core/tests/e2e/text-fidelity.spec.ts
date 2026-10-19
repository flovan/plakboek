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
import {
  createEditablePage,
  readBlockProps,
  section,
} from './helpers/pages.ts';
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
): Promise<{ frame: Frame; field: Locator; pageId: string }> {
  const created = await createEditablePage({
    blocks: [section({ type: 'prose', props: { body } })],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return {
    frame,
    field: frame.locator('.prose-flow').first(),
    pageId: created.pageId,
  };
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

const WORD_HTML = [
  '<html><head><meta charset="utf-8"><style>p.MsoNormal { color: red }</style></head><body>',
  '<!--StartFragment-->',
  '<h1 class="MsoTitle" style="font-size:28pt">Big title</h1>',
  '<p class="MsoNormal" style="color:red;font-size:30px"><span style="font-family:Arial;color:red">Red </span><b>bold words</b><font face="Arial" color="red"> font</font><o:p></o:p></p>',
  '<table><tr><td>cell one</td><td>cell two</td></tr></table>',
  '<!--EndFragment--></body></html>',
].join('');

/** Pastes `html` (and the plain text of it) into the field as the browser would. */
async function paste(
  frame: Frame,
  html: string | null,
  plain: string,
): Promise<void> {
  await frame.evaluate(
    ({ html: markup, plain: words }) => {
      const field = document.querySelector('.prose-flow');
      if (field === null) throw new Error('no field');
      const data = new DataTransfer();
      if (markup !== null) data.setData('text/html', markup);
      data.setData('text/plain', words);
      field.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { html, plain },
  );
}

/** Every node and mark type that appears in a document, and its attributes. */
function inventory(doc: unknown): {
  types: Set<string>;
  headingLevels: number[];
  attributeKeys: Set<string>;
} {
  const found = {
    types: new Set<string>(),
    headingLevels: [] as number[],
    attributeKeys: new Set<string>(),
  };
  function visit(node: unknown): void {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record['type'] === 'string') found.types.add(record['type']);
    const attrs = record['attrs'];
    if (typeof attrs === 'object' && attrs !== null) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== null) found.attributeKeys.add(key);
        if (key === 'level' && typeof value === 'number') {
          found.headingLevels.push(value);
        }
      }
    }
    for (const child of [
      ...((record['content'] as unknown[] | undefined) ?? []),
      ...((record['marks'] as unknown[] | undefined) ?? []),
    ]) {
      visit(child);
    }
  }
  visit(doc);
  return found;
}

test.describe('pasting keeps only what the theme allows', () => {
  test('Word styling, headings and tables never reach the stored document, and the author is told', async ({
    page,
  }) => {
    const { frame, field, pageId } = await openProse(page, {
      type: 'doc',
      content: [paragraph('Start')],
    });
    await typeInField(page, field.locator('p'), '');
    await paste(
      frame,
      WORD_HTML,
      'Big title Red bold words font cell one cell two',
    );

    const notice = page.getByText(
      'Some formatting was removed to match the theme.',
    );
    await expect(notice).toBeVisible();
    await expect(page.locator(`${HOST} [data-toast-message]`)).toHaveAttribute(
      'role',
      'status',
    );
    // leaving the field sends what is pending at once
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    await expect
      .poll(async () =>
        JSON.stringify((await readBlockProps(pageId, 'prose'))['body']),
      )
      .toContain('cell two');

    const stored = (await readBlockProps(pageId, 'prose'))['body'];
    const seen = inventory(stored);
    expect([...seen.types].sort()).toEqual(
      ['bold', 'doc', 'paragraph', 'text'].sort(),
    );
    // the h1 became a paragraph; no colour, size, font or level survived
    expect(seen.headingLevels).toEqual([]);
    expect(seen.attributeKeys.size).toBe(0);
    const plain = JSON.stringify(stored);
    for (const word of ['textColor', 'textSize', 'Arial', 'MsoNormal']) {
      expect(plain).not.toContain(word);
    }
    for (const word of [
      'Big title',
      'Red',
      'bold words',
      'cell one',
      'cell two',
    ]) {
      expect(plain).toContain(word);
    }
    // the cells did not run together
    expect(plain).toContain('cell one cell two');

    // the message leaves by itself
    await expect(notice).toBeHidden({ timeout: 8000 });
  });

  test('a plain text paste shows no message', async ({ page }) => {
    const { frame, field } = await openProse(page, {
      type: 'doc',
      content: [paragraph('Start')],
    });
    await typeInField(page, field.locator('p'), '');
    await paste(frame, null, 'just some words');
    await expect(field.locator('p')).toContainText('just some words');
    await expect(page.locator(`${HOST} [data-toast-message]`)).toHaveCount(0);
  });
});
