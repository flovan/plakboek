/**
 * The standalone Button block, on the real page, in a real browser: its label
 * and link are set in the Properties panel (the link with the same Page search
 * and URL section the popovers use), and it renders through the same
 * renderer as a button typed into a text. Assertions are on what is stored and
 * rendered, never on how the editor builds its controls.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  chrome,
  framedSite,
  HOST,
  openEditor,
  openProperties,
  selectItem,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  paragraph,
  readBlockProps,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';
const POPOVER = '[data-button-popover]';

function tag(): string {
  return Math.random().toString(36).slice(2, 8);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

function sheet(page: Page) {
  return page.locator(`${HOST} [data-properties-sheet]`);
}

/** Adds a Button block after the heading of an open page and returns its element in the frame. */
async function addButtonAfterHeading(page: Page, frame: Frame) {
  await selectItem(page, frame.locator('h2').first());
  await chrome(page)
    .getByRole('button', { name: 'Add after Heading' })
    .first()
    .click();
  const picker = chrome(page).getByRole('dialog', { name: 'Add a block' });
  await expect(picker).toBeVisible();
  await page.keyboard.type('butt');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  return frame.locator('.button-block');
}

test('add a Button block: only its popover opens; Properties and the popover never show together, and a page link set in Properties renders like a CTA after a reload', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Pricing ${word}`,
    blocks: [],
  });
  const created = await createEditablePage({
    blocks: [section(heading('Top'))],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);

  const block = await addButtonAfterHeading(page, frame);
  await expect(block).toHaveCount(1);
  // nothing to show a visitor yet, so the editor shows the unfinished button
  await expect(block.locator('.t-cta')).not.toHaveAttribute('href', /.+/);

  // a new button is set up where it is seen: its popover, with the focus on Label
  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover.getByLabel('Label')).toBeFocused();
  await expect(sheet(page)).not.toHaveAttribute('data-open', '');
  await page.keyboard.type('See pricing');
  await expect(block.locator('.t-cta')).toHaveText('See pricing');

  // asking for Properties (a double click in Page structure; the field's own
  // bar replaces the block toolbar while the popover is open) ends the popover
  await page
    .locator(HOST)
    .getByRole('treeitem', { name: /^Button/ })
    .dblclick();
  await expect(sheet(page)).toHaveAttribute('data-open', '');
  await expect(popover).toHaveCount(0);
  await expect(sheet(page).getByRole('textbox', { name: 'Label' })).toHaveValue(
    'See pricing',
  );
  // the link is required and still empty
  await expect(
    sheet(page).locator('[data-field="link"][data-needs-input]'),
  ).toHaveCount(1);

  const search = sheet(page).getByLabel('Search pages');
  await search.fill(word);
  const row = sheet(page).getByRole('option', { name: `Pricing ${word}` });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(SAVED)).toBeVisible();

  await expect(block.locator('.t-cta')).toHaveText('See pricing');
  await expect(block.locator('.t-cta')).toHaveAttribute('href', target.path);
  await expect(block.locator('.t-cta')).toHaveAttribute(
    'data-variant',
    'primary',
  );
  await expect(
    sheet(page).locator('[data-field="link"][data-needs-input]'),
  ).toHaveCount(0);

  // saved, so what follows cannot be mistaken for a lost write
  await expect
    .poll(async () => (await readBlockProps(created.pageId, 'button'))['link'])
    .toEqual({ href: null, pageId: target.pageId, target: null });

  // a click on the button on the page closes the sheet and opens the popover
  await block.locator('.t-cta').click();
  await expect(popover).toBeVisible();
  await expect(sheet(page)).not.toHaveAttribute('data-open', '');

  await page.reload();
  const reloaded = await framedSite(page);
  const cta = reloaded.locator('.button-block .t-cta');
  await expect(cta).toHaveText('See pricing');
  await expect(cta).toHaveAttribute('href', target.path);
  await expect(cta).toHaveAttribute('data-variant', 'primary');
  const stored = await readBlockProps(created.pageId, 'button');
  expect(stored['link']).toEqual({
    href: null,
    pageId: target.pageId,
    target: null,
  });
});

test('a URL typed in the link control is stored once it is allowed, and Remove link clears it', async ({
  page,
}) => {
  const created = await createEditablePage({
    blocks: [
      section({
        type: 'button',
        props: { label: 'Visit' },
      }),
    ],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  await openProperties(page, frame.locator('.button-block .t-cta'));

  const link = sheet(page).locator('[data-link-control]');
  await link.getByRole('radio', { name: 'URL' }).click();
  const address = link.getByLabel('URL', { exact: true });
  await address.fill('javascript:alert(1)');
  await address.blur();
  await expect(link.getByRole('alert')).toBeVisible();
  await address.fill('https://example.com/pricing');
  await expect(frame.locator('.button-block .t-cta')).toHaveAttribute(
    'href',
    'https://example.com/pricing',
  );
  await expect(page.getByText(SAVED)).toBeVisible();
  await expect
    .poll(async () => (await readBlockProps(created.pageId, 'button'))['link'])
    .toEqual({
      href: 'https://example.com/pricing',
      pageId: null,
      target: null,
    });

  await link.getByRole('button', { name: 'Remove link' }).click();
  await expect(frame.locator('.button-block .t-cta')).not.toHaveAttribute(
    'href',
    /.+/,
  );
  await expect(page.getByText(SAVED)).toBeVisible();
  await expect
    .poll(async () => (await readBlockProps(created.pageId, 'button'))['link'])
    .toBeUndefined();
});

test('clicking a Button block opens its popover on the page, with no caret and no Remove button: a style change renders live and a label and a page link are saved, and Escape closes the popover leaving the block selected', async ({
  page,
}) => {
  const word = tag();
  const target = await createEditablePage({
    title: `Contact ${word}`,
    blocks: [],
  });
  const created = await createEditablePage({
    blocks: [
      section(paragraph('Intro '.repeat(60)), {
        type: 'button',
        props: {
          label: 'Book',
          link: {
            href: 'https://example.com/book',
            pageId: null,
            target: null,
          },
          variant: 'primary',
        },
      }),
    ],
  });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const cta = frame.locator('.button-block .t-cta');

  await cta.click();
  const popover = chrome(page).locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  // nothing in the block is typed into
  await expect(frame.locator('.button-block [contenteditable]')).toHaveCount(0);
  await expect(
    popover.getByRole('button', { name: 'Remove button' }),
  ).toHaveCount(0);
  await expect(popover.getByLabel('Label')).toHaveValue('Book');
  await expect(chrome(page).locator('[data-overlay-selected]')).toHaveCount(1);

  // the style renders live and is saved as the block's own property
  await popover.getByRole('radio', { name: 'Secondary' }).click();
  await expect(cta).toHaveAttribute('data-variant', 'secondary');
  await expect
    .poll(
      async () => (await readBlockProps(created.pageId, 'button'))['variant'],
    )
    .toBe('secondary');

  // the label follows as it is typed
  await popover.getByLabel('Label').fill('Book now');
  await expect(cta).toHaveText('Book now');
  await expect
    .poll(async () => (await readBlockProps(created.pageId, 'button'))['label'])
    .toBe('Book now');

  // the link is picked by page, stored by id
  await popover.getByRole('radio', { name: 'Page' }).click();
  await popover.getByLabel('Search pages').fill(word);
  await popover.getByRole('option', { name: `Contact ${word}` }).click();
  await expect(cta).toHaveAttribute('href', target.path);
  await expect
    .poll(async () => (await readBlockProps(created.pageId, 'button'))['link'])
    .toEqual({ href: null, pageId: target.pageId, target: null });

  // Done closes it with the block still selected
  await popover.getByRole('button', { name: 'Done' }).click();
  await expect(popover).toHaveCount(0);
  await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  await expect(chrome(page).locator('[data-overlay-selected]')).toHaveCount(1);

  // Escape closes a reopened popover too, leaving the block selected
  await cta.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(chrome(page).locator('[data-overlay-selected]')).toHaveCount(1);
  await expect(page.locator(`${HOST} [role="status"].sr-only`)).toContainText(
    'Stopped editing',
  );

  await page.reload();
  const reloaded = (await framedSite(page)).locator('.button-block .t-cta');
  await expect(reloaded).toHaveText('Book now');
  await expect(reloaded).toHaveAttribute('data-variant', 'secondary');
  await expect(reloaded).toHaveAttribute('href', target.path);
});

test('a Button block and a button typed into a text with the same label, link and style render the same markup, for the editor and for a visitor', async ({
  page,
  request,
}) => {
  const link = { href: 'https://example.com/same', pageId: null, target: null };
  const created = await createEditablePage({
    publish: true,
    blocks: [
      section(
        {
          type: 'prose',
          props: {
            body: {
              type: 'doc',
              content: [
                {
                  type: 'cta',
                  attrs: { label: 'Same', ...link, variant: 'secondary' },
                },
              ],
            },
          },
        },
        {
          type: 'button',
          props: { label: 'Same', link, variant: 'secondary' },
        },
      ),
    ],
  });

  const buttons = (html: string): string[] =>
    html.match(/<a[^>]*class="t-cta"[^>]*>[^<]*<\/a>/g) ?? [];
  const visitor = buttons(await (await request.get(created.path)).text());
  expect(visitor).toHaveLength(2);
  expect(visitor[0]).toBe(visitor[1]);

  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const outer = (selector: string): Promise<string> =>
    frame
      .locator(selector)
      .first()
      .evaluate((element) => element.outerHTML);
  expect(await outer('.button-block .t-cta')).toBe(
    await outer('.prose-flow .t-cta'),
  );
});

test('a Button block whose page is not available shows a visitor nothing and its data is kept, and one with no link says it needs one in the editor', async ({
  page,
  request,
}) => {
  // a draft page has no public address yet
  const draft = await createEditablePage({ title: 'Not yet', blocks: [] });
  const created = await createEditablePage({
    publish: true,
    blocks: [
      section(paragraph('Hello'), {
        type: 'button',
        props: {
          label: 'Go',
          link: { href: null, pageId: draft.pageId, target: null },
        },
      }),
    ],
  });

  const visitor = await (await request.get(created.path)).text();
  expect(visitor).toContain('Hello');
  expect(visitor).not.toContain('t-cta');
  expect((await readBlockProps(created.pageId, 'button'))['label']).toBe('Go');

  // a block still being made, with no link at all, is marked in the editor
  const unfinished = await createEditablePage({
    blocks: [
      section(paragraph('Hello'), { type: 'button', props: { label: 'Go' } }),
    ],
  });
  await openEditor(page, unfinished.path);
  const frame = await framedSite(page);
  await expect(frame.locator('.button-block .t-cta')).toHaveText('Go');
  await expect(frame.locator('.button-block .t-cta')).not.toHaveAttribute(
    'href',
    /.+/,
  );
  await openProperties(page, frame.locator('.button-block .t-cta'));
  await expect(
    sheet(page).locator('[data-field="link"] [data-needs-input-tag]'),
  ).toHaveText('Needs input');
});

test('the Needs input badge of a Button block with no label and no link opens its popover, not the Properties sheet', async ({
  page,
}) => {
  const created = await createEditablePage({
    blocks: [section(paragraph('Hello'), { type: 'button', props: {} })],
  });
  await openEditor(page, created.path);

  await chrome(page).locator('[data-marker]').click();

  await expect(chrome(page).locator(POPOVER)).toBeVisible();
  await expect(sheet(page)).not.toHaveAttribute('data-open', '');
});
