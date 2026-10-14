/**
 * Removing and copying on the page, in a real browser: a delete of an item
 * holding blocks asks first and says how many go with it, one that holds none
 * is instant, both leave an undo toast and a session undo that brings the item
 * back under its own ids; duplicate puts a copy right after the original; the
 * toolbar and the keyboard follow the same guards, and a role that may not
 * delete cannot.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { framedSite, HOST, openEditor } from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const TOAST = `${HOST} [data-toast]`;
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
    await frame.locator('section.section').nth(0).locator('h2').first().click();
    await deleteButton(page).click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Delete this section?' }),
    ).toBeVisible();
    await expect(dialog).toContainText('This removes 2 blocks inside it.');
    await expect(dialog).toContainText('You can undo this right after.');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
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
});
