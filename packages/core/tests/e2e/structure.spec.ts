/**
 * Rearranging on the page, in a real browser: the floating toolbar's move
 * buttons and the keyboard model turn into one autosaved write each, the frame
 * is patched in place, undo and redo apply the inverse and forward writes, and
 * a failed save leaves the page as it was and can be retried.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  expectSelectedOver,
  framedSite,
  HOST,
  openEditor,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const TOOLBAR = `${HOST} [role="toolbar"]`;
const SAVED = 'All changes saved';

/** Section A: a column with H1 and H2. Section B: a column with H3. */
async function twoSections(publish = false): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(heading('H1'), heading('H2')), section(heading('H3'))],
    publish,
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

function moveButton(page: Page, direction: string) {
  return page.getByRole('button', {
    name: new RegExp(`^Move .* ${direction}$`),
  });
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('moving by the toolbar', () => {
  test('Move down on the last heading of a column lands it at the top of the next column, saved and still there after a reload', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 1);
    await expectSelectedOver(
      page,
      frame,
      'section.section >> nth=0 >> h2 >> nth=1',
    );
    await expect(page.locator(TOOLBAR)).toBeVisible();

    await moveButton(page, 'down').click();

    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
    expect(await headingsIn(frame, 0)).toEqual(['H1']);
    await expectSaved(page);
    // the moved heading stays selected, in its new place
    await expectSelectedOver(
      page,
      frame,
      'section.section >> nth=1 >> h2 >> nth=0',
    );

    await page.reload();
    const reloaded = await framedSite(page);
    await expect.poll(() => headingsIn(reloaded, 1)).toEqual(['H2', 'H3']);
    expect(await headingsIn(reloaded, 0)).toEqual(['H1']);
  });
});
