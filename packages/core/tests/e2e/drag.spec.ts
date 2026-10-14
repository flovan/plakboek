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
  paragraph,
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

/** The centre of a frame element, a few pixels below its bottom edge: the gap after it. */
async function gapAfter(
  frame: Frame,
  selector: string,
): Promise<{ x: number; y: number }> {
  const box = await frameBoxOf(frame, selector);
  return { x: box.x + box.width / 2, y: box.y + box.height + 2 };
}

const H3 = 'section.section >> nth=2 >> h2 >> nth=0';

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

test.describe('dragging a block type from the palette', () => {
  test('a Text row dropped into a column puts a selected Text block there, saved and still there after a reload', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await frame.locator(H3).scrollIntoViewIfNeeded();

    const row = await page
      .locator(`${HOST} [data-palette-row="text"]`)
      .boundingBox();
    if (row === null) throw new Error('The Text row has no box');
    await page.mouse.move(row.x + 20, row.y + 10);
    await page.mouse.down();
    await page.mouse.move(row.x + 40, row.y + 30, { steps: 3 });
    await expect(page.locator(SURFACE)).toBeVisible();
    const target = await gapAfter(frame, H3);
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect(page.locator(LINE)).toBeVisible();
    await page.mouse.up();

    const tags = (): Promise<string[]> =>
      frame
        .locator('section.section')
        .nth(2)
        .locator('h2, p')
        .evaluateAll((elements) =>
          elements.map((element) => element.tagName.toLowerCase()),
        );
    await expect.poll(tags).toEqual(['h2', 'p', 'h2']);
    await expect(page.getByText(SAVED)).toBeVisible();
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect
      .poll(() =>
        reloaded.locator('section.section').nth(2).locator('p').count(),
      )
      .toBe(1);
  });
});

test.describe('where a line shows', () => {
  test('a heading over the site header, where nothing may be placed, gets no line and a no-drop cursor', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await frame.evaluate(() => window.scrollTo(0, 0));
    await drillTo(frame, 1, 0);
    await pickUp(page);

    const header = await frameBoxOf(frame, '.site-header');
    await page.mouse.move(header.x + 200, header.y + header.height / 2, {
      steps: 8,
    });
    await expect(page.locator(SURFACE)).toHaveAttribute('data-legal', 'false');
    await expect(page.locator(LINE)).toHaveCount(0);

    // Back over a column the same drag shows a line again.
    const target = await gapAfter(frame, H3);
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect(page.locator(SURFACE)).toHaveAttribute('data-legal', 'true');
    await expect(page.locator(LINE)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('a section dragged over the blank part of another section lines up between the top-level sections and drops there', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    // The first section fills the window: its blank lower part is outside any column.
    await frame.evaluate(() => window.scrollTo(0, 0));
    await frame.locator('section.section').nth(2).click();
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await pickUp(page);
    const first = await frameBoxOf(frame, 'section.section >> nth=0');
    await page.mouse.move(
      first.x + first.width / 2,
      first.y + first.height - 40,
      {
        steps: 8,
      },
    );
    await expect(page.locator(LINE)).toBeVisible();
    // Between sections the line runs across the page, not between items of a column.
    await expect(page.locator(LINE)).toHaveAttribute('data-axis', 'horizontal');
    await page.mouse.up();

    await expect
      .poll(() =>
        frame
          .locator('section.section')
          .evaluateAll((sections) =>
            sections.map((element) => element.querySelector('h2')?.textContent),
          ),
      )
      .toEqual(['Top', 'H3', 'H1']);
    await expect(page.getByText(SAVED)).toBeVisible();
  });
});

test.describe('ending a drag without a change', () => {
  test('Escape mid-drag leaves the order unchanged and the page unsaved-free', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 1, 0);
    await pickUp(page);
    const target = await gapAfter(frame, H3);
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect(page.locator(LINE)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(SURFACE)).toHaveCount(0);
    await expect(page.locator(LINE)).toHaveCount(0);
    await page.mouse.up();
    expect(await headingsIn(frame, 1)).toEqual(['H1', 'H2']);
    expect(await headingsIn(frame, 2)).toEqual(['H3', 'H4']);
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  test('a release outside the frame cancels', async ({ page }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 1, 0);
    await pickUp(page);
    const target = await gapAfter(frame, H3);
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect(page.locator(LINE)).toBeVisible();

    await page.mouse.move(60, 400, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(SURFACE)).toHaveCount(0);
    expect(await headingsIn(frame, 1)).toEqual(['H1', 'H2']);
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });
});

test.describe('near the frame edge', () => {
  test('holding the pointer near the bottom scrolls the frame', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(heading('Top'), paragraph('One')),
        section(heading('Below')),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await frame.evaluate(() => window.scrollTo(0, 0));
    await drillTo(frame, 0, 0);
    await pickUp(page);

    const view = await page.locator(`${HOST} iframe`).boundingBox();
    if (view === null) throw new Error('The frame has no box');
    await page.mouse.move(view.x + view.width / 2, view.y + view.height - 10, {
      steps: 6,
    });
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});

test.describe('a drop that is not saved', () => {
  test('an aborted write shows the failed status and the frame keeps the order it had', async ({
    page,
  }) => {
    // the write retries three times with backoff before it gives up
    test.setTimeout(60_000);
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 1, 0);
    await page.route('**/cms/api/pages/*/edit', (route) => route.abort());

    await pickUp(page);
    const target = await gapAfter(frame, H3);
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();

    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Could not save your changes' }),
    ).toBeVisible({ timeout: 15_000 });
    expect(await headingsIn(frame, 1)).toEqual(['H1', 'H2']);
    expect(await headingsIn(frame, 2)).toEqual(['H3', 'H4']);
  });
});
