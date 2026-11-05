/**
 * Page structure in a real browser: the sidebar lists the page's items, a row
 * selects its item and brings it into view on the page, hovering a row shows
 * where the block is, and the keyboard reaches every row.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  chrome,
  expectSelectedOver,
  framedSite,
  HOST,
  LIVE_REGION,
  openEditor,
  SELECTED,
  selectItem,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import { createEditablePage, heading, section } from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const TALL = { type: 'spacer', props: { size: 'tall' } } as const;

/** The id the live render gives the heading with this text. */
async function headingId(frame: Frame, text: string): Promise<string> {
  const id = await frame
    .locator('[data-pk-type="heading"]', { hasText: text })
    .first()
    .getAttribute('data-pk-block');
  if (id === null) throw new Error(`No heading "${text}" in the frame`);
  return id;
}

function row(page: Page, id: string) {
  return page.locator(`${HOST} [data-tree-row="${id}"]`);
}

async function openLongPage(page: Page): Promise<void> {
  const created = await createEditablePage({
    blocks: [section(heading('Top'), TALL), section(heading('Far'))],
  });
  await openEditor(page, created.path);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('Page structure', () => {
  test('a row selects its item and scrolls it into view', async ({ page }) => {
    await openLongPage(page);
    const frame = await framedSite(page);
    const far = await headingId(frame, 'Far');
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(0);

    await row(page, far).click();
    await expect(page.locator(LIVE_REGION)).toHaveText(
      'Selected Heading, 1 of 1 in Column 1.',
    );
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await expect(frame.locator(`[data-pk-block="${far}"]`)).toBeInViewport();
    await expectSelectedOver(
      page,
      frame,
      '[data-pk-type="heading"]:has-text("Far")',
    );
  });

  test('hovering a row outlines its block on the page, and leaving removes the outline', async ({
    page,
  }) => {
    await openLongPage(page);
    const frame = await framedSite(page);
    const top = await headingId(frame, 'Top');
    const highlight = `[data-overlay-highlight="${top}"]`;

    await row(page, top).hover();
    await expect(chrome(page).locator(highlight)).toHaveCount(1);

    await page.getByRole('heading', { name: 'Page structure' }).hover();
    await expect(chrome(page).locator(highlight)).toHaveCount(0);
  });

  test('a double-click on a row opens its Properties in the sheet with the first control focused', async ({
    page,
  }) => {
    await openLongPage(page);
    const frame = await framedSite(page);
    const top = await headingId(frame, 'Top');

    await row(page, top).dblclick();
    await expect(
      page.locator(`${HOST} [data-properties-sheet][data-open]`),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused();
  });

  test('works from the keyboard: arrows move without selecting, Left and Right collapse and expand, Enter selects and opens Properties', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('H1'), { type: 'text', props: {} })],
    });
    await openEditor(page, created.path);
    const rows = page.locator(`${HOST} [data-tree-row]`);
    const focusedRow = page.locator(`${HOST} [data-tree-row]:focus`);

    // a block with a required value still empty says so
    await expect(rows).toHaveCount(4);
    await expect(
      rows.filter({ hasText: 'Needs input' }).filter({ hasText: 'Text' }),
    ).toHaveCount(1);

    // the tree is one tab stop, and the first row is it
    for (let presses = 0; presses < 40; presses += 1) {
      if ((await focusedRow.count()) === 1) break;
      await page.keyboard.press('Tab');
    }
    await expect(focusedRow).toHaveAttribute('aria-level', '1');

    await page.keyboard.press('ArrowDown');
    await expect(focusedRow).toHaveAttribute('aria-level', '2');
    await expect(chrome(page).locator(SELECTED)).toHaveCount(0);

    await page.keyboard.press('ArrowUp');
    await expect(focusedRow).toHaveAttribute('aria-level', '1');
    await page.keyboard.press('ArrowLeft');
    await expect(rows).toHaveCount(1);
    await expect(focusedRow).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(rows).toHaveCount(4);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(focusedRow).toContainText('Heading');
    await page.keyboard.press('Enter');
    await expect(page.locator(LIVE_REGION)).toHaveText(
      'Selected Heading, 1 of 2 in Column 1.',
    );
    await expect(
      page.locator(`${HOST} [data-properties-sheet][data-open]`),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused();
  });

  test('marks the row of the item selected on the page', async ({ page }) => {
    const created = await createEditablePage({
      blocks: [section(heading('H1'))],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const id = await headingId(frame, 'H1');
    const target = frame.getByRole('heading', { name: 'H1' });

    await selectItem(page, target);
    await expect(row(page, id)).toHaveAttribute('aria-selected', 'true');
  });
});
