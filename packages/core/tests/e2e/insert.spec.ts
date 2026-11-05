/**
 * Adding to the page, in a real browser: the insert points between siblings,
 * the picker of only the types legal there, the prompts of empty places, the
 * toolbar's Add after and the `+` key, and the markers of blocks that still need
 * a value.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  chrome,
  frameBoxOf,
  framedSite,
  HOST,
  LIVE_REGION,
  openEditor,
  regionFocused,
  SELECTED,
  selectItem,
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
const MARKER = '[data-marker]';
const TOOLBAR = '[role="toolbar"]';

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

/** Selects the heading at the given position in the first section. */
async function selectHeading(
  page: Page,
  frame: Frame,
  at: number,
): Promise<void> {
  await selectItem(
    page,
    frame.locator('section.section').first().locator('h2').nth(at),
  );
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
  return chrome(page).evaluate(
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
    await selectHeading(page, frame, 0);
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);

    await hoverGapBetweenHeadings(page, frame);
    await chrome(page)
      .getByRole('button', { name: 'Add block after Heading' })
      .first()
      .click();
    const picker = chrome(page).getByRole('dialog', { name: 'Add a block' });
    await expect(picker).toBeVisible();
    await page.keyboard.type('tex');
    // Bare text matches too; Text is the best match and so comes first
    await expect(picker.getByRole('option').first()).toHaveText(/^Text/);
    await page.keyboard.press('Enter');

    await expect(picker).toHaveCount(0);
    await expect
      .poll(() => tagsInFirstColumn(frame))
      .toEqual(['h2', 'p', 'h2']);
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
    // the missing text is typed at once: one message says added, needs input and editing
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await expect(page.locator(LIVE_REGION)).toHaveText(
      /^Added Text\. Needs input\. Editing .+\. Press Escape to stop editing\.$/,
    );
    await page.keyboard.type('New text');
    await expect(
      frame.locator('section.section').first().locator('p'),
    ).toHaveText('New text');

    // Escape leaves the block selected with the focus on the page, and Enter goes back in
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    await expect.poll(() => regionFocused(page)).toBe(true);
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await page.keyboard.press('Escape');
    await expectSaved(page);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect
      .poll(() => tagsInFirstColumn(reloaded))
      .toEqual(['h2', 'p', 'h2']);
  });
});

test.describe('the picker', () => {
  test('Escape closes the picker and adds nothing; the arrow keys choose among the legal types and Enter adds the active one', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await tabToRegion(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');

    const picker = chrome(page).getByRole('dialog', { name: 'Add a block' });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect.poll(() => regionFocused(page)).toBe(true);
    // nothing was added
    expect(await tagsInFirstColumn(frame)).toEqual(['h2', 'h2']);

    await page.keyboard.press('+');
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

    const card = chrome(page).locator('[data-empty-page]');
    await expect(card).toContainText('This page has no sections yet');
    await expect(card).toContainText(
      'Add a section to start building the page.',
    );
    // a core section is the only legal section type, so there is nothing to pick
    await chrome(page).getByRole('button', { name: 'Add a section' }).click();

    await expect(live).toContainText('Added Section.');
    await expect(card).toHaveCount(0);
    await expect(frame.locator('section.section')).toHaveCount(1);
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
    await expectSaved(page);

    // the new section starts with one column, which is empty and says how to fill it
    const prompt = chrome(page).locator('[data-empty-add]');
    await expect(prompt).toHaveCount(1);
    await expect(prompt).toHaveText('Add block');
    await prompt.click();
    const picker = chrome(page).getByRole('dialog', { name: 'Add a block' });
    await page.keyboard.type('head');
    await page.keyboard.press('Enter');

    await expect(picker).toHaveCount(0);
    await expect(frame.locator('section.section h2')).toHaveCount(1);
    await expect(prompt).toHaveCount(0);
    // its text is required and still empty
    await expect(chrome(page).locator(MARKER)).toHaveCount(1);
    await expect(chrome(page).locator(MARKER)).toHaveText('Needs input');
    await expect(live).toHaveText(
      /^Added Heading\. Needs input\. Editing .+\. Press Escape to stop editing\./,
    );
  });

  test('a block whose required values are filled shows no marker', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('H1'), paragraph('Some text'))],
    });
    await openEditor(page, created.path);
    await expect(chrome(page).locator('[data-empty-box]')).toHaveCount(0);
    await expect(chrome(page).locator(MARKER)).toHaveCount(0);
  });

  test('Add after opens the picker for the gap after the selected block, and the + key from the page region does the same', async ({
    page,
  }) => {
    const created = await pageWithTwoHeadings();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectHeading(page, frame, 0);

    await chrome(page)
      .locator(TOOLBAR)
      .getByRole('button', { name: 'Add after Heading' })
      .click();
    const picker = chrome(page).getByRole('dialog', { name: 'Add a block' });
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
    const picker = chrome(page).getByRole('dialog', { name: 'Add a block' });
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
    const empty = chrome(narrowed).getByRole('dialog', { name: 'Add a block' });
    await expect(empty).toContainText('Nothing can be added here');
    await expect(empty).toContainText(
      'The page structure does not allow another block in this spot.',
    );
  });
});
