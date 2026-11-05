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
  chrome,
  framedSite,
  HOST,
  openEditor,
  selectedId,
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

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test('a paragraph: the caret lands in the clicked word', async ({ page }) => {
  const { field } = await openProse(page);

  const holder = field.locator('.t-p >> nth=1');
  await typeInField(page, holder, '', await pointInWord(holder, 'several', 3));

  await page.keyboard.type('X');
  await expect(field.locator('p', { hasText: 'X' })).toHaveText(
    'The second paragraph has sevXeral words in it.',
  );
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

/** What the e2e host's theme declares, plus one size only a wider theme knows. */
const WIDER_THEME = {
  colors: [
    { label: 'Accent', token: 'accent' },
    { label: 'Muted', token: 'text-muted' },
  ],
  sizes: [
    { label: 'Large', token: 'xl' },
    { label: 'Huge', token: 'huge' },
  ],
  align: true,
  ctaVariants: [
    { label: 'Primary', value: 'primary' },
    { label: 'Secondary', value: 'secondary' },
  ],
};

const OUT_OF_THEME_BODY = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        text('Kept words '),
        {
          type: 'text',
          text: 'in a size the theme dropped',
          marks: [{ type: 'textSize', attrs: { token: 'huge' } }],
        },
      ],
    },
  ],
};

async function openOutOfTheme(
  page: Parameters<typeof openEditor>[0],
): Promise<{ frame: Frame; field: Locator; pageId: string }> {
  const created = await createEditablePage({
    textTheme: WIDER_THEME,
    blocks: [section({ type: 'prose', props: { body: OUT_OF_THEME_BODY } })],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  return {
    frame,
    field: frame.locator('.prose-flow').first(),
    pageId: created.pageId,
  };
}

test.describe('stored text the theme no longer allows is kept until the editor chooses', () => {
  const NOTICE = '[data-unsupported-notice]';

  test('a click shows the notice instead of a caret, and Keep as is changes nothing', async ({
    page,
  }) => {
    await page.clock.install();
    const { field, pageId } = await openOutOfTheme(page);
    const before = await readBlockProps(pageId, 'prose');

    await field.locator('p').click();
    const notice = chrome(page).locator(NOTICE);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      'This text has formatting the theme no longer allows',
    );
    // the field was not mounted: no editor, no caret, nothing that can strip it
    await expect(field).not.toHaveAttribute('contenteditable', 'true');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    // the block is selected and keeps its toolbar
    expect(await selectedId(page)).not.toBeNull();
    await expect(
      chrome(page).getByRole('button', { name: 'Duplicate' }),
    ).toBeVisible();

    await notice.getByRole('button', { name: 'Keep as is' }).click();
    await expect(notice).toHaveCount(0);
    await expect(field).not.toHaveAttribute('contenteditable', 'true');
    // typing goes nowhere and nothing is queued
    const sent: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/cms\/api\/pages\/[^/]+\/(preview|edit)$/.test(
          new URL(request.url()).pathname,
        )
      ) {
        sent.push(request.url());
      }
    });
    await page.keyboard.type('zzz');
    await expect(field.locator('p')).toContainText('Kept words');
    await page.clock.fastForward(2_000);
    expect(sent).toEqual([]);
    expect(await readBlockProps(pageId, 'prose')).toEqual(before);
  });

  test('Remove unsupported formatting keeps every word, saves, and the field becomes editable', async ({
    page,
  }) => {
    const { field, pageId } = await openOutOfTheme(page);
    await field.locator('p').click();
    const notice = chrome(page).locator(NOTICE);
    await expect(notice).toBeVisible();

    await notice
      .getByRole('button', { name: 'Remove unsupported formatting' })
      .click();
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await expect(notice).toHaveCount(0);
    await expect(field).toHaveAttribute('contenteditable', 'true');

    const stored = JSON.stringify(
      (await readBlockProps(pageId, 'prose'))['body'],
    );
    expect(stored).toContain('Kept words ');
    expect(stored).toContain('in a size the theme dropped');
    expect(stored).not.toContain('textSize');

    // the caret is at the end of the field
    await page.keyboard.type('!');
    await expect(field.locator('p')).toHaveText(
      'Kept words in a size the theme dropped!',
    );
  });

  test('a failed remove-formatting save keeps the notice and shows the save error row', async ({
    page,
  }) => {
    const { field } = await openOutOfTheme(page);
    await field.locator('p').click();
    const notice = chrome(page).locator(NOTICE);
    await expect(notice).toBeVisible();

    await page.route('**/cms/api/pages/*/edit', (route) => route.abort());
    await notice
      .getByRole('button', { name: 'Remove unsupported formatting' })
      .click();
    await expect(page.getByText('Could not save your changes')).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(field).not.toHaveAttribute('contenteditable', 'true');
  });
});

test.describe('an empty field invites typing', () => {
  const CHIP = '[data-field-chip]';

  test('the chip shows while the block is selected, is not saved, and leaves with the first character', async ({
    page,
  }) => {
    const { field, pageId } = await openProse(page, { type: 'doc' });
    await expect(chrome(page).locator(CHIP)).toHaveCount(0);

    await field.click({ position: { x: 4, y: 4 } });
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    const chip = chrome(page).locator(CHIP);
    await expect(chip).toHaveText('Start typing, or press / for more');

    await page.keyboard.type('Hi');
    await expect(chip).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect
      .poll(async () =>
        JSON.stringify((await readBlockProps(pageId, 'prose'))['body']),
      )
      .toContain('Hi');
    expect(
      JSON.stringify((await readBlockProps(pageId, 'prose'))['body']),
    ).not.toContain('Start typing');
  });

  test('the selection tint is dropped while a field is active', async ({
    page,
  }) => {
    const { field } = await openProse(page);
    await expect(chrome(page).locator('[data-field-boundary]')).toHaveCount(0);
    await typeInField(page, field.locator('.t-p').first(), '');
    await expect(
      chrome(page).locator('[data-overlay-selected]'),
    ).toHaveAttribute('data-field-active', '');
    await page.keyboard.press('Escape');
    await expect(
      chrome(page).locator('[data-overlay-selected]'),
    ).not.toHaveAttribute('data-field-active', '');
  });
});
