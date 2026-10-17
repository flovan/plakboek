/**
 * Page structure in a real browser: the sidebar lists the page's items, a row
 * selects its item and brings it into view on the page, hovering a row shows
 * where the block is, and the keyboard reaches every row.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  expectSelectedOver,
  framedSite,
  frameBoxOf,
  HOST,
  LIVE_REGION,
  openEditor,
  SELECTED,
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
  test('a row selects its item and scrolls it into view, unless it is already fully visible', async ({
    page,
  }) => {
    await openLongPage(page);
    const frame = await framedSite(page);
    const far = await headingId(frame, 'Far');
    const top = await headingId(frame, 'Top');
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(0);

    await row(page, far).click();
    await expect(page.locator(LIVE_REGION)).toHaveText(
      'Selected Heading, 1 of 1 in Column 1.',
    );
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        frame.evaluate((id) => {
          const box = document
            .querySelector(`[data-pk-block="${id}"]`)
            ?.getBoundingClientRect();
          return (
            box !== undefined &&
            box.top >= 0 &&
            box.bottom <= document.documentElement.clientHeight
          );
        }, far),
      )
      .toBe(true);
    await expectSelectedOver(
      page,
      frame,
      '[data-pk-type="heading"]:has-text("Far")',
    );

    // a fully visible item does not scroll the page
    await frame.evaluate(() =>
      window.scrollTo({ top: 0, behavior: 'instant' }),
    );
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(0);
    await row(page, top).click();
    await expect(row(page, top)).toHaveAttribute('aria-selected', 'true');
    await frame.evaluate(
      () =>
        new Promise<void>((done) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              done();
            });
          });
        }),
    );
    expect(await frame.evaluate(() => window.scrollY)).toBe(0);
  });

  test('hovering a row outlines its block on the page, and leaving removes the outline', async ({
    page,
  }) => {
    await openLongPage(page);
    const frame = await framedSite(page);
    const top = await headingId(frame, 'Top');
    const highlight = `${HOST} [data-overlay-highlight="${top}"]`;

    await row(page, top).hover();
    await expect(page.locator(highlight)).toHaveCount(1);
    await expect
      .poll(async () => {
        const outline = await page
          .locator(`${highlight} .pk-overlay-outline`)
          .boundingBox();
        const heading = await frameBoxOf(frame, `[data-pk-block="${top}"]`);
        if (outline === null) return Number.POSITIVE_INFINITY;
        return Math.max(
          Math.abs(outline.x - heading.x),
          Math.abs(outline.y - heading.y),
          Math.abs(outline.width - heading.width),
          Math.abs(outline.height - heading.height),
        );
      })
      .toBeLessThanOrEqual(1);

    await page.getByRole('heading', { name: 'Page structure' }).hover();
    await expect(page.locator(highlight)).toHaveCount(0);
  });

  test('leaving a hovered row gives the outline back to the row that has focus', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('One'), heading('Two'))],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const first = await headingId(frame, 'One');
    const second = await headingId(frame, 'Two');
    const highlight = (id: string) =>
      page.locator(`${HOST} [data-overlay-highlight="${id}"]`);

    await row(page, first).focus();
    await row(page, second).hover();
    await expect(highlight(second)).toHaveCount(1);

    await page.getByRole('heading', { name: 'Page structure' }).hover();
    await expect(highlight(second)).toHaveCount(0);
    await expect(highlight(first)).toHaveCount(1);
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
    await expect(page.locator(SELECTED)).toHaveCount(0);

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

    // a section with one column selects the column, and the next level the heading
    await target.dblclick();
    await target.dblclick();
    await expect(row(page, id)).toHaveAttribute('aria-selected', 'true');
  });
});
