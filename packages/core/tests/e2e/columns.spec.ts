/**
 * A section's columns on the page, in a real browser: adding, removing and
 * re-ordering them from the Columns group, choosing how they share the width
 * and line up from the Layout group, a block that fills its column, and the
 * insert points and toolbar buttons that add a column. Every change shows in
 * the frame at once, is saved, and is still there after a reload.
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

const SAVED = 'All changes saved';

/** The section's columns in the frame, in order. */
function columnsIn(frame: Frame, sectionIndex = 0) {
  return frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('[data-plakboek-columns] > [data-pk-block]');
}

async function widthsOf(frame: Frame, sectionIndex = 0): Promise<number[]> {
  return await columnsIn(frame, sectionIndex).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
}

function propertiesTab(page: Page) {
  return page.getByRole('tab', { name: 'Properties' });
}

/** The group of the open Properties panel, named by its `data-properties-group`. */
function group(page: Page, name: 'columns' | 'layout' | 'placement') {
  return page.locator(`${HOST} [data-properties-group="${name}"]`);
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Selects the first section by clicking inside it, and opens the Properties tab. */
async function selectSection(
  page: Page,
  frame: Frame,
  sectionIndex = 0,
): Promise<void> {
  await frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .first()
    .click();
  await propertiesTab(page).click();
  await expect(group(page, 'columns')).toBeVisible();
}

async function openOneColumnSection(page: Page): Promise<EditablePage> {
  const created = await createEditablePage({
    blocks: [section(heading('Alpha'), heading('Beta'))],
  });
  await openEditor(page, created.path);
  return created;
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('adding a column and choosing its width', () => {
  test('Add column makes two equal columns, the 2 to 1 tile makes the first wider, and both are saved', async ({
    page,
  }) => {
    await openOneColumnSection(page);
    const frame = await framedSite(page);
    await selectSection(page, frame);

    const columns = group(page, 'columns');
    await expect(columns.locator('[data-column-row]')).toHaveCount(1);
    await expect(columns.getByText('2 blocks')).toBeVisible();
    // one column: nothing to choose
    await expect(group(page, 'layout')).toContainText(
      'Columns are equal width.',
    );

    await columns.getByRole('button', { name: 'Add column' }).click();
    await expect(columnsIn(frame)).toHaveCount(2);
    await expectSaved(page);

    // the new column is selected; its panel points to the section's layout
    await expect(
      page.getByText("Column width comes from the section's layout."),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open section layout' }).click();

    const widths = page.getByRole('radiogroup', { name: 'Column widths' });
    await expect(widths.getByRole('radio')).toHaveCount(3);
    await expect(widths.getByRole('radio', { name: '1 to 1' })).toBeChecked();
    await expect(widths.getByRole('radio', { name: '2 to 1' })).toBeVisible();
    await expect(widths.getByRole('radio', { name: '1 to 2' })).toBeVisible();
    // opening the section's layout puts focus on the group
    await expect(widths.getByRole('radio', { name: '1 to 1' })).toBeFocused();

    const [equalFirst, equalSecond] = await widthsOf(frame);
    expect(Math.abs((equalFirst ?? 0) - (equalSecond ?? 0))).toBeLessThan(2);

    await widths.getByRole('radio', { name: '2 to 1' }).click();
    await expect(widths.getByRole('radio', { name: '2 to 1' })).toBeChecked();
    await expect
      .poll(async () => {
        const [first, second] = await widthsOf(frame);
        return (first ?? 0) > (second ?? 0);
      })
      .toBe(true);
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect(columnsIn(reloaded)).toHaveCount(2);
    const [first, second] = await widthsOf(reloaded);
    expect(first).toBeGreaterThan(second ?? 0);
    await selectSection(page, reloaded);
    await expect(
      page
        .getByRole('radiogroup', { name: 'Column widths' })
        .getByRole('radio', { name: '2 to 1' }),
    ).toBeChecked();
  });
});
