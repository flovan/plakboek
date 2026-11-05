/**
 * A section's columns on the page, in a real browser: adding, removing and
 * re-ordering them from the Columns group, choosing how they share the width
 * and line up from the Layout group, a block that fills its column, and the
 * insert points and toolbar buttons that add a column. Every change shows in
 * the frame at once, is saved, and is still there after a reload.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  chrome,
  framedSite,
  HOST,
  openEditor,
  openProperties,
  waitForShell,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  type EditablePage,
  type FactoryBlock,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const SAVED = 'All changes saved';
const TOAST = `${HOST} [data-toast]`;
const TOOLBAR = '[role="toolbar"]';

/** A section whose columns hold the given blocks, one list per column. */
function columnsSection(...columns: readonly FactoryBlock[][]): FactoryBlock {
  return {
    type: 'section',
    props: { variant: 'plain' },
    children: columns.map((children) => ({ type: 'column', children })),
  };
}

/** The stored layout of every section on the page, in order, read from the editor API. */
async function storedLayouts(
  page: Page,
  pageId: string,
): Promise<readonly unknown[]> {
  const response = await page.request.get(`/cms/api/pages/${pageId}/tree`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    tree: { kind: string; layout: unknown }[];
  };
  return body.tree
    .filter((node) => node.kind === 'section')
    .map((node) => node.layout);
}

/** The text of the headings in each column of a section, in order. */
async function headingsByColumn(
  frame: Frame,
  sectionIndex = 0,
): Promise<string[][]> {
  return await columnsIn(frame, sectionIndex).evaluateAll((columns) =>
    columns.map((column) =>
      [...column.querySelectorAll('h2')].map((h2) => h2.textContent ?? ''),
    ),
  );
}

/** The section's columns in the frame, in order. */
function columnsIn(frame: Frame, sectionIndex = 0) {
  return frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('[data-plakboek-columns] > [data-pk-block]');
}

/** The stored layout of the first block of a type on the page, read from the editor API. */
async function storedLayoutOf(
  page: Page,
  pageId: string,
  type: string,
): Promise<unknown> {
  const response = await page.request.get(`/cms/api/pages/${pageId}/tree`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    tree: { type: string; layout: unknown }[];
  };
  const node = body.tree.find((entry) => entry.type === type);
  if (node === undefined) throw new Error(`The page has no ${type} block`);
  return node.layout;
}

/** The column count the rendered section writes on its grid element. */
function gridOf(frame: Frame, sectionIndex = 0) {
  return frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('[data-plakboek-columns]');
}

/** The group of the open Properties panel, named by its `data-properties-group`. */
function group(page: Page, name: 'columns' | 'layout' | 'placement') {
  return page.locator(`${HOST} [data-properties-group="${name}"]`);
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

/** Selects a section and opens its Properties. */
async function selectSection(
  page: Page,
  frame: Frame,
  sectionIndex = 0,
): Promise<void> {
  await openProperties(
    page,
    frame.locator('section.section').nth(sectionIndex),
  );
  await expect(group(page, 'columns')).toBeVisible();
}

/** Reloads the editor and waits until its session runs and the frame's clicks are claimed again. */
async function reloadEditor(page: Page): Promise<Frame> {
  await page.reload();
  await waitForShell(page);
  await expect(page.locator(HOST)).toHaveAttribute('data-session', 'editing');
  await expect(page.locator(`${HOST} iframe`)).toHaveAttribute(
    'tabindex',
    '-1',
  );
  return await framedSite(page);
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
    const created = await openOneColumnSection(page);
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
    await expect(gridOf(frame)).toHaveAttribute('data-plakboek-columns', '2');
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

    // equal columns store no ratio
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([null]);

    await widths.getByRole('radio', { name: '2 to 1' }).click();
    await expect(widths.getByRole('radio', { name: '2 to 1' })).toBeChecked();
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ columns: '2:1' }]);

    const reloaded = await reloadEditor(page);
    await expect(columnsIn(reloaded)).toHaveCount(2);
    await expect(gridOf(reloaded)).toHaveAttribute(
      'data-plakboek-columns',
      '2',
    );
    await selectSection(page, reloaded);
    await expect(
      page
        .getByRole('radiogroup', { name: 'Column widths' })
        .getByRole('radio', { name: '2 to 1' }),
    ).toBeChecked();
  });
});

test.describe('removing a column', () => {
  test('an empty column goes at once and the section goes back to the equal split; Undo brings back the column and the ratio', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [columnsSection([heading('Alpha')], [], [])],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectSection(page, frame);

    const widths = page.getByRole('radiogroup', { name: 'Column widths' });
    await widths.getByRole('radio', { name: '2 to 1 to 1' }).click();
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ columns: '2:1:1' }]);

    await group(page, 'columns')
      .getByRole('button', { name: 'Remove Column 3' })
      .click();
    // it holds nothing, so nothing is asked
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator(TOAST)).toContainText('Column 3 deleted');
    await expect(columnsIn(frame)).toHaveCount(2);
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([null]);

    await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();
    await expect(columnsIn(frame)).toHaveCount(3);
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ columns: '2:1:1' }]);
    await expect(gridOf(frame)).toHaveAttribute('data-plakboek-columns', '3');
  });

  test('a column holding two blocks asks first and says how many go; Undo brings both back in the column', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [columnsSection([heading('H1'), heading('H2')], [heading('H3')])],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectSection(page, frame);

    await group(page, 'columns')
      .getByRole('button', { name: 'Remove Column 1' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Delete this column?' }),
    ).toBeVisible();
    await expect(dialog).toContainText('This removes 2 blocks inside it.');
    expect(await headingsByColumn(frame)).toEqual([['H1', 'H2'], ['H3']]);

    await dialog.getByRole('button', { name: 'Delete column' }).click();
    await expect(columnsIn(frame)).toHaveCount(1);
    expect(await headingsByColumn(frame)).toEqual([['H3']]);
    await expectSaved(page);

    await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();
    await expect(columnsIn(frame)).toHaveCount(2);
    expect(await headingsByColumn(frame)).toEqual([['H1', 'H2'], ['H3']]);
    await expectSaved(page);

    expect(await headingsByColumn(await reloadEditor(page))).toEqual([
      ['H1', 'H2'],
      ['H3'],
    ]);
  });

  test("a section's only column cannot be removed: the button is disabled and says why", async ({
    page,
  }) => {
    await openOneColumnSection(page);
    const frame = await framedSite(page);
    await selectSection(page, frame);

    const remove = group(page, 'columns').getByRole('button', {
      name: 'Remove Column 1',
    });
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(remove).toHaveAttribute(
      'title',
      'A section needs at least one column.',
    );
    // a forced click skips the wait for the sliding sheet to stop; a hover keeps it
    await remove.hover();
    await remove.click({ force: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(columnsIn(frame)).toHaveCount(1);
  });
});

test.describe('moving a column', () => {
  test('earlier makes the second column the first, and later from the end puts it first in the next section', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        columnsSection([heading('A')], [heading('B')]),
        columnsSection([heading('C')]),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectSection(page, frame);
    const columns = group(page, 'columns');

    await expect(
      columns.getByRole('button', { name: 'Move Column 1 earlier' }),
    ).toHaveAttribute('aria-disabled', 'true');

    await columns
      .getByRole('button', { name: 'Move Column 2 earlier' })
      .click();
    await expect.poll(() => headingsByColumn(frame)).toEqual([['B'], ['A']]);
    await expectSaved(page);

    // A is the last column of the first section: later crosses into the next one
    await columns.getByRole('button', { name: 'Move Column 2 later' }).click();
    await expect.poll(() => headingsByColumn(frame)).toEqual([['B']]);
    await expect.poll(() => headingsByColumn(frame, 1)).toEqual([['A'], ['C']]);
    await expectSaved(page);

    const reloaded = await reloadEditor(page);
    expect(await headingsByColumn(reloaded)).toEqual([['B']]);
    expect(await headingsByColumn(reloaded, 1)).toEqual([['A'], ['C']]);
  });
});

test.describe('the alignment of the columns', () => {
  test('Center lines the columns up in the middle of the section, saved and there after a reload', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [columnsSection([heading('A')], [heading('B')])],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    expect(await storedLayouts(page, created.pageId)).toEqual([null]);

    await selectSection(page, frame);
    const alignment = page.getByRole('radiogroup', {
      name: 'Column alignment',
    });
    await expect(
      alignment.getByRole('radio', { name: 'Stretch' }),
    ).toBeChecked();
    await alignment.getByRole('radio', { name: 'Center' }).click();
    await expect(
      alignment.getByRole('radio', { name: 'Center' }),
    ).toBeChecked();
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ align: 'center' }]);

    const reloaded = await reloadEditor(page);
    await selectSection(page, reloaded);
    await expect(
      page
        .getByRole('radiogroup', { name: 'Column alignment' })
        .getByRole('radio', { name: 'Center' }),
    ).toBeChecked();
  });
});

test.describe('a block that fills its column', () => {
  test('Fill column height is saved on and off and shown after a reload', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        columnsSection(
          [{ type: 'quote', props: { text: 'Short quote' } }],
          [{ type: 'spacer', props: { size: 'short' } }],
        ),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const quote = frame.locator('blockquote.quote');

    await openProperties(page, quote);
    const placement = group(page, 'placement');
    const fill = placement.getByRole('switch', { name: 'Fill column height' });
    await expect(fill).not.toBeChecked();
    await expect(placement).toContainText(
      'Stretches this block to the full height of its column.',
    );

    await fill.click();
    await expect(fill).toBeChecked();
    await expectSaved(page);
    await expect
      .poll(() => storedLayoutOf(page, created.pageId, 'quote'))
      .toEqual({ fill: true });

    const reloaded = await reloadEditor(page);
    await openProperties(page, reloaded.locator('blockquote.quote'));
    const reloadedFill = page.getByRole('switch', {
      name: 'Fill column height',
    });
    await expect(reloadedFill).toBeChecked();
    await reloadedFill.click();
    await expect(reloadedFill).not.toBeChecked();
    await expectSaved(page);
    await expect
      .poll(async () => {
        const layout = await storedLayoutOf(page, created.pageId, 'quote');
        return (layout as { fill?: boolean } | null)?.fill ?? false;
      })
      .toBe(false);
  });

  test('a block that does not declare fill support has no Placement group', async ({
    page,
  }) => {
    await openOneColumnSection(page);
    const frame = await framedSite(page);
    await openProperties(page, frame.locator('section.section h2').first());
    await expect(page.locator(`${HOST} [data-properties-panel]`)).toBeVisible();
    await expect(group(page, 'placement')).toHaveCount(0);
  });
});

test.describe('adding a column from the page', () => {
  test('the always-visible vertical line between two columns adds a column right there', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [columnsSection([heading('A')], [heading('B')])],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectSection(page, frame);

    const lines = chrome(page).locator('[data-insert][data-always]');
    // between the two and after the last, both running top to bottom
    await expect(lines).toHaveCount(2);
    await expect(lines.first()).toHaveAttribute('data-line', 'down');

    await chrome(page)
      .getByRole('button', { name: 'Add column here' })
      .first()
      .click();
    await expect(columnsIn(frame)).toHaveCount(3);
    expect(await headingsByColumn(frame)).toEqual([['A'], [], ['B']]);
    await expectSaved(page);
    // the new column is selected, so the lines stay for the next one
    await expect(lines).toHaveCount(3);
  });

  test("the toolbar's Add after on a column adds a column after it, and Open section layout goes back to the section", async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [columnsSection([heading('A')], [heading('B')])],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectSection(page, frame);

    await group(page, 'columns')
      .getByRole('button', { name: 'Column 1', exact: true })
      .click();
    await chrome(page)
      .locator(TOOLBAR)
      .getByRole('button', { name: 'Add after Column 1' })
      .click();
    await expect(columnsIn(frame)).toHaveCount(3);
    expect(await headingsByColumn(frame)).toEqual([['A'], [], ['B']]);
    await expectSaved(page);

    // the new column is selected; its panel points at the section's layout
    await expect(group(page, 'layout')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open section layout' }).click();
    await expect(group(page, 'layout')).toBeVisible();
    await expect(group(page, 'columns')).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: 'Column widths' }),
    ).toBeVisible();
  });
});

test.describe('copying and removing a column from the toolbar and the keyboard', () => {
  test('both put the section back on the equal split in the same write, and Undo restores the ratio', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [columnsSection([heading('A')], [heading('B')], [heading('C')])],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectSection(page, frame);
    await page
      .getByRole('radiogroup', { name: 'Column widths' })
      .getByRole('radio', { name: '2 to 1 to 1' })
      .click();
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ columns: '2:1:1' }]);

    // the toolbar's Duplicate on the second column
    await group(page, 'columns')
      .getByRole('button', { name: 'Column 2', exact: true })
      .click();
    await chrome(page)
      .locator(TOOLBAR)
      .getByRole('button', { name: 'Duplicate Column 2' })
      .click();
    await expect(columnsIn(frame)).toHaveCount(4);
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([null]);
    expect(await headingsByColumn(frame)).toEqual([['A'], ['B'], ['B'], ['C']]);

    // the sheet covers the sidebar's Undo button, so Undo is the shortcut
    await page.locator(`${HOST} #plakboek-stage`).focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await expect(columnsIn(frame)).toHaveCount(3);
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ columns: '2:1:1' }]);

    // Delete from the keyboard on the last column, which holds a block
    await group(page, 'columns')
      .getByRole('button', { name: 'Column 3', exact: true })
      .click();
    await page.locator(`${HOST} #plakboek-stage`).focus();
    await page.keyboard.press('Delete');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete column' })
      .click();
    await expect(columnsIn(frame)).toHaveCount(2);
    await expectSaved(page);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([null]);

    await page.locator(TOAST).getByRole('button', { name: 'Undo' }).click();
    await expect(columnsIn(frame)).toHaveCount(3);
    await expectSaved(page);
    expect(await headingsByColumn(frame)).toEqual([['A'], ['B'], ['C']]);
    await expect
      .poll(() => storedLayouts(page, created.pageId))
      .toEqual([{ columns: '2:1:1' }]);
  });
});
