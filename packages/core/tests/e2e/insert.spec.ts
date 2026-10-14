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
  HOST,
  LIVE_REGION,
  openEditor,
  SELECTED,
  tabToRegion,
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
const MARKER = `${HOST} [data-marker]`;
const TOOLBAR = `${HOST} [role="toolbar"]`;

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

/** The attribute of the shell element that has focus, or null. */
function focusedAttribute(page: Page, name: string): Promise<string | null> {
  return page
    .locator(HOST)
    .evaluate(
      (host, attribute) =>
        host.shadowRoot?.activeElement?.getAttribute(attribute) ?? null,
      name,
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

test.describe('the picker', () => {
  test('Escape closes it and hands focus back to the insert point that opened it', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillToHeading(frame, 0);
    await hoverGapBetweenHeadings(page, frame);
    const button = page
      .getByRole('button', { name: 'Add block after Heading' })
      .first();
    const slot = await button.getAttribute('data-slot');
    await button.click();
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await expect(picker.getByRole('combobox')).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(picker).toHaveCount(0);
    await expect.poll(() => focusedAttribute(page, 'data-slot')).toBe(slot);
    // nothing was added
    expect(await tagsInFirstColumn(frame)).toEqual(['h2', 'h2']);
  });

  test('the arrow keys choose among the legal types and Enter adds the active one', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    await tabToRegion(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');

    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await expect(picker).toBeVisible();
    // the column is never offered, and only types that can go in a column are
    const options = await picker.getByRole('option').allTextContents();
    expect(options.length).toBeGreaterThan(3);
    expect(options.join(' ')).not.toContain('Column');
    expect(options.some((text) => text.startsWith('Section'))).toBe(true);
    const first = await picker
      .getByRole('option')
      .first()
      .locator('span')
      .first()
      .textContent();
    // down and up again leaves the first option active
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');

    await expect(picker).toHaveCount(0);
    await expectSaved(page);
    await expect(page.locator(LIVE_REGION)).toContainText(`Added ${first}.`);
  });
});

test.describe('empty places and the blocks that need a value', () => {
  test('an empty page offers a section, which starts with a column, and that column offers a block that then shows it needs input', async ({
    page,
  }) => {
    const created = await createEditablePage({ blocks: [] });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const live = page.locator(LIVE_REGION);

    const card = page.locator(`${HOST} [data-empty-page]`);
    await expect(card).toContainText('This page has no sections yet');
    await expect(card).toContainText(
      'Add a section to start building the page.',
    );
    // a core section is the only legal section type, so there is nothing to pick
    await page.getByRole('button', { name: 'Add a section' }).click();

    await expect(live).toContainText('Added Section.');
    await expect(card).toHaveCount(0);
    await expect(frame.locator('section.section')).toHaveCount(1);
    await expect(page.locator(SELECTED)).toHaveCount(1);
    await expectSaved(page);

    // the new section starts with one column, which is empty and says how to fill it
    const prompt = page.locator(`${HOST} [data-empty-add]`);
    await expect(prompt).toHaveCount(1);
    await expect(prompt).toHaveText('Add block');
    await prompt.click();
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await page.keyboard.type('head');
    await page.keyboard.press('Enter');

    await expect(picker).toHaveCount(0);
    await expect(frame.locator('section.section h2')).toHaveCount(1);
    await expect(prompt).toHaveCount(0);
    // its text is required and still empty
    await expect(page.locator(MARKER)).toHaveCount(1);
    await expect(page.locator(MARKER)).toHaveText('Needs input');
    await expect(live).toHaveText(/Added Heading\. Needs input\.$/);
  });

  test('a block whose required values are filled shows no marker', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('H1'), paragraph('Some text'))],
    });
    await openEditor(page, created.path);
    await expect(page.locator(`${HOST} [data-empty-box]`)).toHaveCount(0);
    await expect(page.locator(MARKER)).toHaveCount(0);
  });

  test('Add after opens the picker for the gap after the selected block, and the + key from the page region does the same', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillToHeading(frame, 0);

    await page
      .locator(TOOLBAR)
      .getByRole('button', { name: 'Add after Heading' })
      .click();
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect.poll(() => focusedAttribute(page, 'data-roving')).toBe('add');

    // from the region
    await tabToRegion(page);
    await page.keyboard.press('+');
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('a search with no match, and a gap where nothing is legal, say so', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    await tabToRegion(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');
    const picker = page.getByRole('dialog', { name: 'Add a block' });
    await page.keyboard.type('zzzz');
    await expect(picker).toContainText('No blocks match "zzzz".');
    await expect(picker.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(picker).toBeVisible();

    // a catalogue that offers no block for a column leaves nothing to add
    const narrowed = await page.context().newPage();
    await signIn(narrowed, e2eUsers().editor);
    await narrowed.route('**/cms/api/open', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        catalogue: { key: string }[];
      };
      body.catalogue = body.catalogue.filter((entry) => entry.key === 'column');
      await route.fulfill({ response, json: body });
    });
    await openEditor(narrowed, created.path);
    await tabToRegion(narrowed);
    await narrowed.keyboard.press('ArrowDown');
    await narrowed.keyboard.press('ArrowRight');
    await narrowed.keyboard.press('ArrowRight');
    await narrowed.keyboard.press('+');
    const empty = narrowed.getByRole('dialog', { name: 'Add a block' });
    await expect(empty).toContainText('Nothing can be added here');
    await expect(empty).toContainText(
      'The page structure does not allow another block in this spot.',
    );
  });
});
