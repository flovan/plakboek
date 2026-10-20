/**
 * Text in the Properties panel: formatted text shows a read-only preview and an
 * Edit on page button that starts typing in the field on the page, a property
 * the block never marks as a field says so, a short text keeps its counter, and
 * the needs-input marker and the Enter key lead into the same in-place session.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  chrome,
  framedSite,
  HOST,
  openEditor,
  openProperties,
  selectItem,
  selectedId,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  readBlockProps,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

function paragraphDoc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** The Properties sheet. */
function sheet(page: Page) {
  return page.locator(`${HOST} [data-properties-sheet]`);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('formatted text in the Properties panel', () => {
  test('shows the words as a read-only preview, and Edit on page starts typing with the caret at the end of the field', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section({
          type: 'prose',
          props: { body: paragraphDoc('Hello world') },
        }),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const field = frame.locator('.prose-flow').first();
    await openProperties(page, field);

    const row = sheet(page).locator('[data-rich-text-row="body"]');
    await expect(row.locator('[data-text-preview]')).toHaveText('Hello world');
    await expect(
      sheet(page).locator('[data-note="note-rich-text"]'),
    ).toHaveCount(0);
    await expect(row).toContainText(
      'Formatted text is edited directly on the page.',
    );
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');

    await row.getByRole('button', { name: 'Edit Body on the page' }).click();
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await expect(field).toHaveAttribute('contenteditable', 'true');
    // the caret is at the end, so typing appends
    await page.keyboard.type('!');
    await expect(field).toHaveText('Hello world!');
    // and the panel preview follows what is typed
    await expect(row.locator('[data-text-preview]')).toHaveText('Hello world!');
  });

  test('an empty property says there is no text yet', async ({ page }) => {
    const created = await createEditablePage({
      blocks: [section({ type: 'prose', props: {} })],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await openProperties(page, frame.locator('.prose-block').first());

    const row = sheet(page).locator('[data-rich-text-row="body"]');
    await expect(row.locator('[data-text-preview]')).toHaveText('No text yet');
    await expect(
      row.getByRole('button', { name: 'Edit Body on the page' }),
    ).toBeVisible();
  });

  test('a rich text property the block never marks as a field shows the preview and a note, with no button', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section({
          type: 'propsDemo',
          props: { title: 'Demo', body: paragraphDoc('Not on the page') },
        }),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await openProperties(
      page,
      frame.locator('section.section >> .props-demo >> p >> nth=0'),
    );

    const row = sheet(page).locator('[data-rich-text-row="body"]');
    await expect(row.locator('[data-text-preview]')).toHaveText(
      'Not on the page',
    );
    await expect(row).toContainText('This text is not editable on the page.');
    await expect(row.getByRole('button')).toHaveCount(0);
  });
});

test.describe('the routes into the text on the page', () => {
  test('a short text with a limit counts its characters in the panel, live', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('Hello'))],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await openProperties(page, frame.locator('h2.reset-target').first());

    const counter = sheet(page).locator('[data-text-counter]');
    await expect(counter).toHaveText('5 of 200 characters');
    await page.getByRole('textbox', { name: 'Text' }).fill('Hello there');
    await expect(counter).toHaveText('11 of 200 characters');
  });

  test('a needs-input marker on a missing text starts typing in it on the page, and Properties stay closed', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section({
          type: 'card',
          props: { title: 'A card' },
        }),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await chrome(page).locator('[data-marker]').click();
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await expect(sheet(page)).not.toHaveAttribute('data-open', '');
    await page.keyboard.type('Typed here');
    await expect(frame.locator('.card-caption')).toHaveText('Typed here');
    await page.keyboard.press('Escape');
    await expect
      .poll(async () =>
        JSON.stringify(
          (await readBlockProps(created.pageId, 'card'))['caption'],
        ),
      )
      .toContain('Typed here');
    // nothing is missing any more
    await expect(chrome(page).locator('[data-marker]')).toHaveCount(0);
  });

  test('Enter on a selected block with text puts the caret at the end of the field; on a block without text it opens Properties', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(
          { type: 'prose', props: { body: paragraphDoc('Hello world') } },
          { type: 'propsDemo', props: { title: 'Demo' } },
        ),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const field = frame.locator('.prose-flow').first();

    await selectItem(page, field);
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    const id = await selectedId(page);
    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await expect(sheet(page)).not.toHaveAttribute('data-open', '');
    await page.keyboard.type('!');
    await expect(field).toHaveText('Hello world!');
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    expect(await selectedId(page)).toBe(id);

    // a block with no text to type in keeps the Phase 8 route
    await selectItem(
      page,
      frame.locator('section.section >> .props-demo >> p >> nth=0'),
    );
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toHaveAttribute('data-open', '');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  });
});
