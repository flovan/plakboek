/**
 * Removing and copying on the page, in a real browser: a delete of an item
 * holding blocks asks first and says how many go with it, one that holds none
 * is instant, both leave an undo toast and a session undo that brings the item
 * back under its own ids; duplicate puts a copy right after the original; the
 * toolbar and the keyboard follow the same guards, and a role that may not
 * delete cannot.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  expectSelectedOver,
  framedSite,
  HOST,
  openEditor,
  regionFocused,
  tabToRegion,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';
import { createTestUser } from './helpers/users.ts';

const TOAST = `${HOST} [data-toast]`;
const TOOLBAR = `${HOST} [role="toolbar"]`;
const SAVED = 'All changes saved';

/** Section A holds H1 and H2, section B holds H3. */
async function twoSections(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(heading('H1'), heading('H2')), section(heading('H3'))],
  });
}

/** Every block id of the framed page, in document order. */
function blockIds(frame: Frame): Promise<string[]> {
  return frame
    .locator('[data-pk-block]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-pk-block') ?? ''),
    );
}

function headingsIn(frame: Frame, sectionIndex: number): Promise<string[]> {
  return frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .allTextContents();
}

function deleteButton(page: Page) {
  return page.getByRole('button', { name: /^Delete / });
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Double-click twice: section to column, column to the block under the pointer. */
async function drillToHeading(frame: Frame, sectionIndex: number, at: number) {
  const target = frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .nth(at);
  await target.dblclick();
  await target.dblclick();
}

/** Selects the first heading with the keyboard alone: section, column, heading. */
async function selectFirstHeadingByKeyboard(page: Page): Promise<void> {
  await tabToRegion(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
}

function tooltipOf(page: Page, text: string) {
  return page.locator(`${TOOLBAR} [data-tooltip]`, { hasText: text });
}

test.describe('with a role that may delete', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, e2eUsers().editor);
  });

  test.describe('deleting an item that holds blocks', () => {
    test('asks first, deletes, and Undo brings the section back with the same ids, saved and after a reload', async ({
      page,
    }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      const before = await blockIds(frame);

      // a click at the page's scope selects the section
      await frame
        .locator('section.section')
        .nth(0)
        .locator('h2')
        .first()
        .click();
      await deleteButton(page).click();

      const dialog = page.getByRole('dialog');
      await expect(
        dialog.getByRole('heading', { name: 'Delete this section?' }),
      ).toBeVisible();
      await expect(dialog).toContainText('This removes 2 blocks inside it.');
      await expect(dialog).toContainText('You can undo this right after.');
      await expect(
        dialog.getByRole('button', { name: 'Cancel' }),
      ).toBeFocused();
      // nothing has changed yet
      expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);

      await dialog.getByRole('button', { name: 'Delete section' }).click();

      await expect(dialog).toHaveCount(0);
      await expect.poll(() => frame.locator('section.section').count()).toBe(1);
      expect(await headingsIn(frame, 0)).toEqual(['H3']);
      await expect(page.locator(TOAST)).toContainText('Section deleted');
      await expectSaved(page);

      await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();

      await expect.poll(() => frame.locator('section.section').count()).toBe(2);
      expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
      expect(await blockIds(frame)).toEqual(before);
      await expect(page.locator(TOAST)).toHaveCount(0);
      await expectSaved(page);
      await expect(page.locator(`${HOST} [data-live-region]`)).toHaveText(
        'Restored Section.',
      );

      await page.reload();
      const reloaded = await framedSite(page);
      await expect.poll(() => blockIds(reloaded)).toEqual(before);
    });

    test('Cancel and Escape change nothing and hand focus back to the Delete button', async ({
      page,
    }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await frame
        .locator('section.section')
        .nth(0)
        .locator('h2')
        .first()
        .click();
      const dialog = page.getByRole('dialog');

      await deleteButton(page).click();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(deleteButton(page)).toBeFocused();

      await deleteButton(page).click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(deleteButton(page)).toBeFocused();

      expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
      await expect(page.locator(`${HOST} [data-overlay-selected]`)).toHaveCount(
        1,
      );
      await expect(page.locator(TOAST)).toHaveCount(0);
    });
  });

  test.describe('deleting an item that holds no blocks', () => {
    test('a single heading goes at once, the next sibling is selected, and the toast offers Undo', async ({
      page,
    }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await drillToHeading(frame, 0, 0);

      await deleteButton(page).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect.poll(() => headingsIn(frame, 0)).toEqual(['H2']);
      await expect(page.locator(TOAST)).toContainText('Heading deleted');
      await expectSelectedOver(
        page,
        frame,
        'section.section >> nth=0 >> h2 >> nth=0',
      );
      await expectSaved(page);

      await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();
      await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H2']);
      await expectSelectedOver(
        page,
        frame,
        'section.section >> nth=0 >> h2 >> nth=0',
      );
    });

    test('the toast goes after eight seconds', async ({ page }) => {
      test.setTimeout(60_000);
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await drillToHeading(frame, 0, 0);
      await deleteButton(page).click();
      await expect(page.locator(TOAST)).toBeVisible();

      await expect(page.locator(TOAST)).toBeHidden({ timeout: 15_000 });
    });

    test('the toast stays while it is hovered', async ({ page }) => {
      test.setTimeout(60_000);
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await drillToHeading(frame, 0, 0);
      await deleteButton(page).click();
      await page.locator(TOAST).hover();

      await page.waitForTimeout(9_000);

      await expect(page.locator(TOAST)).toBeVisible();
    });

    test('a newer delete replaces the toast, and Undo undoes that one', async ({
      page,
    }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await drillToHeading(frame, 0, 0);
      await deleteButton(page).click();
      await expect.poll(() => headingsIn(frame, 0)).toEqual(['H2']);
      await expectSaved(page);
      await deleteButton(page).click();
      await expect.poll(() => headingsIn(frame, 0)).toEqual([]);

      await expect(page.locator(TOAST)).toHaveCount(1);
      await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();

      await expect.poll(() => headingsIn(frame, 0)).toEqual(['H2']);
    });
  });

  test.describe('the last column of a section', () => {
    test('cannot be deleted and says why', async ({ page }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      // double-click a heading: the section's only column
      await frame
        .locator('section.section')
        .nth(0)
        .locator('h2')
        .first()
        .dblclick();

      const button = deleteButton(page);
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(
        tooltipOf(page, 'A section needs at least one column.'),
      ).toHaveCount(1);
      await button.click({ force: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    });
  });

  test.describe('duplicating', () => {
    test('a column with a heading gets a copy right after it, selected, and it is still there after a reload', async ({
      page,
    }) => {
      const created = await createEditablePage({
        blocks: [section(heading('H1'))],
      });
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await frame.locator('section.section h2').first().dblclick();
      const original = await blockIds(frame);

      await page.getByRole('button', { name: /^Duplicate / }).click();

      const columns = frame.locator('[data-pk-type="column"]');
      await expect(columns).toHaveCount(2);
      await expect(frame.locator('section.section h2')).toHaveText([
        'H1',
        'H1',
      ]);
      const copied = await blockIds(frame);
      // the original ids stay and come first; the copy has ids of its own
      expect(copied.slice(0, original.length)).toEqual(original);
      expect(new Set(copied).size).toBe(copied.length);
      await expectSelectedOver(page, frame, '[data-pk-type="column"] >> nth=1');
      await expectSaved(page);
      await expect(page.locator(TOAST)).toHaveCount(0);

      await page.reload();
      const reloaded = await framedSite(page);
      await expect(reloaded.locator('[data-pk-type="column"]')).toHaveCount(2);
      await expect(reloaded.locator('section.section h2')).toHaveText([
        'H1',
        'H1',
      ]);
    });
  });

  test.describe('from the keyboard', () => {
    test('Control or Command and D copies the selection, Delete removes the copy, and focus stays in the region', async ({
      page,
    }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await selectFirstHeadingByKeyboard(page);

      await page.keyboard.press('ControlOrMeta+D');

      await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H1', 'H2']);
      await expectSelectedOver(
        page,
        frame,
        'section.section >> nth=0 >> h2 >> nth=1',
      );
      await expectSaved(page);
      expect(await regionFocused(page)).toBe(true);

      await page.keyboard.press('Delete');

      await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H2']);
      await expect(page.locator(TOAST)).toContainText('Heading deleted');
      // the next sibling of the removed copy
      await expectSelectedOver(
        page,
        frame,
        'section.section >> nth=0 >> h2 >> nth=1',
      );
      await expect.poll(() => regionFocused(page)).toBe(true);
    });

    test('Backspace on a section asks first, and Escape leaves it alone', async ({
      page,
    }) => {
      const created = await twoSections();
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await tabToRegion(page);
      await page.keyboard.press('ArrowDown');

      await page.keyboard.press('Backspace');

      await expect(page.getByRole('dialog')).toContainText(
        'This removes 2 blocks inside it.',
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
      // Escape closed the dialog and did not climb the selection
      await expect(page.locator(`${HOST} [data-overlay-selected]`)).toHaveCount(
        1,
      );
      await expect.poll(() => regionFocused(page)).toBe(true);
    });
  });
});

test.describe('with a role that may edit but not delete', () => {
  test('Delete is off with the reason, a copy can be made, and its undo is off too', async ({
    page,
  }) => {
    await signIn(page, await createTestUser({ roleKey: 'editor-no-delete' }));
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillToHeading(frame, 0, 0);

    const reason = "Your role can't delete content on this page.";
    await expect(deleteButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(tooltipOf(page, reason)).toHaveCount(1);
    await deleteButton(page).click({ force: true });
    expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);

    await page.getByRole('button', { name: /^Duplicate / }).click();
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H1', 'H2']);
    await expectSaved(page);

    // undoing a copy deletes it, which this role may not do
    const undo = page.getByRole('button', { name: 'Undo' });
    await expect(undo).toHaveAttribute('aria-disabled', 'true');
    await undo.click({ force: true });
    expect(await headingsIn(frame, 0)).toEqual(['H1', 'H1', 'H2']);
  });
});
