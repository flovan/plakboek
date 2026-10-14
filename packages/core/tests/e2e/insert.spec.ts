/**
 * Adding to the page, in a real browser: the insert points between siblings,
 * the picker of only the types legal there, the prompts of empty places, the
 * toolbar's Add after and the `+` key, the markers of blocks that still need a
 * value, and the Blocks palette in the sidebar.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  frameBoxOf,
  framedSite,
  LIVE_REGION,
  openEditor,
  SELECTED,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';

/** Section A holds H1 and H2. */
async function pageWithTwoHeadings(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(heading('H1'), heading('H2'))],
  });
}

/** The tag names of the blocks of the first column, in order. */
function tagsInFirstColumn(frame: Frame): Promise<string[]> {
  return frame
    .locator('section.section')
    .first()
    .locator('h2, p')
    .evaluateAll((elements) =>
      elements.map((element) => element.tagName.toLowerCase()),
    );
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Double-click twice: section to column, column to the block under the pointer. */
async function drillToHeading(frame: Frame, at: number): Promise<void> {
  const target = frame.locator('section.section').first().locator('h2').nth(at);
  await target.dblclick();
  await target.dblclick();
}

/** Moves the pointer into the gap between the first two headings. */
async function hoverGapBetweenHeadings(
  page: Page,
  frame: Frame,
): Promise<void> {
  const first = await frameBoxOf(frame, 'section.section >> h2 >> nth=0');
  const second = await frameBoxOf(frame, 'section.section >> h2 >> nth=1');
  await page.mouse.move(
    first.x + first.width / 2,
    (first.y + first.height + second.y) / 2,
  );
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('the insert points and the picker', () => {
  test('hovering the gap between two headings, pressing + and picking Text puts a selected Text block there, saved and still there after a reload', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillToHeading(frame, 0);
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await hoverGapBetweenHeadings(page, frame);
    await page
      .getByRole('button', { name: 'Add block after Heading' })
      .first()
      .click();
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await expect(picker).toBeVisible();
    await page.keyboard.type('tex');
    await expect(picker.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');

    await expect(picker).toHaveCount(0);
    await expect
      .poll(() => tagsInFirstColumn(frame))
      .toEqual(['h2', 'p', 'h2']);
    await expectSaved(page);
    await expect(page.locator(LIVE_REGION)).toContainText('Added Text.');
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect
      .poll(() => tagsInFirstColumn(reloaded))
      .toEqual(['h2', 'p', 'h2']);
  });
});
