/**
 * The standalone Button block, on the real page, in a real browser: its label
 * and link are set in the Properties panel (the link with the same Page search
 * and Web address section the popovers use), and it renders through the same
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
  readBlockProps,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';

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

test('add a Button block, set its label and point it at a page in Properties: it renders like a CTA and is still there after a reload', async ({
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

  await chrome(page)
    .getByRole('button', { name: /^Properties of / })
    .click();
  await expect(sheet(page)).toHaveAttribute('data-open', '');
  // the link is required and still empty
  await expect(
    sheet(page).locator('[data-field="link"][data-needs-input]'),
  ).toHaveCount(1);

  await sheet(page).getByRole('textbox', { name: 'Label' }).fill('See pricing');
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

test('a web address typed in the link control is stored once it is allowed, and Remove link clears it', async ({
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
  await link.getByRole('radio', { name: 'Web address' }).click();
  const address = link.getByLabel('Web address', { exact: true });
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
