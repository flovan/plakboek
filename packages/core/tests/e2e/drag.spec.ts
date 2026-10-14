/**
 * Dragging on the page, in a real browser: the toolbar's handle and the
 * palette's rows start a drag after 4px, a capture surface in the shell takes
 * the pointer over the frame, an insertion line shows only where the placement
 * rules allow, and the drop is one saved write. The keyboard does the same
 * with no pointer at all.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  framedSite,
  frameBoxOf,
  HOST,
  openEditor,
  SELECTED,
  type Rect,
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
const HANDLE = `${HOST} [data-drag-handle]`;
const LINE = `${HOST} [data-drag-line]`;
const SURFACE = `${HOST} [data-drag-surface]`;

/**
 * A first section that fills the window (the site's theme sizes it so), then
 * section A with H1 and H2 and section B with H3 and H4.
 */
async function twoSections(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [
      section(heading('Top')),
      section(heading('H1'), heading('H2')),
      section(heading('H3'), heading('H4')),
    ],
  });
}

function headingsIn(frame: Frame, sectionIndex: number): Promise<string[]> {
  return frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .allTextContents();
}

/** Double-click twice: section to column, column to the block under the pointer. */
async function drillTo(frame: Frame, sectionIndex: number, at: number) {
  const target = frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .nth(at);
  await target.dblclick();
  await target.dblclick();
}

/** The handle's box once the toolbar has stopped settling into place. */
async function settledHandle(page: Page): Promise<Rect> {
  let previous = '';
  let box: Rect | null = null;
  await expect
    .poll(async () => {
      box = await page.locator(HANDLE).boundingBox();
      const now = JSON.stringify(box);
      const settled = box !== null && now === previous;
      previous = now;
      return settled;
    })
    .toBe(true);
  if (box === null) throw new Error('The drag handle has no box');
  return box;
}

/** Presses the selected item's drag handle and moves 10px, so the drag is on. */
async function pickUp(page: Page): Promise<void> {
  const handle = await settledHandle(page);
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y + 10, { steps: 3 });
  await expect(page.locator(SURFACE)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('dragging by the handle', () => {
  test('a heading dragged into another section lands between its two headings, saved and still there after a reload', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 1, 0);
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await pickUp(page);
    const third = await frameBoxOf(
      frame,
      'section.section >> nth=2 >> h2 >> nth=0',
    );
    await page.mouse.move(
      third.x + third.width / 2,
      third.y + third.height + 2,
      {
        steps: 8,
      },
    );
    await expect(page.locator(LINE)).toBeVisible();
    // The page does not reflow while the item is carried.
    expect(await headingsIn(frame, 1)).toEqual(['H1', 'H2']);
    await page.mouse.up();

    await expect(page.locator(SURFACE)).toHaveCount(0);
    await expect.poll(() => headingsIn(frame, 2)).toEqual(['H3', 'H1', 'H4']);
    expect(await headingsIn(frame, 1)).toEqual(['H2']);
    await expect(page.getByText(SAVED)).toBeVisible();
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect
      .poll(() => headingsIn(reloaded, 2))
      .toEqual(['H3', 'H1', 'H4']);
  });
});
