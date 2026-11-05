/**
 * Selecting on the page, in a real browser: an editor opens a page for
 * editing, clicks claim the framed site's events and select by the scope
 * rules, and the Edit and Interact toggle hands the site back.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  chrome,
  expectSelectedOver,
  frameBoxOf,
  framedSite,
  FRAME,
  HOST,
  LIVE_REGION,
  MODE_GROUP,
  openEditor,
  SCOPE,
  SELECTED,
  selectItem,
  waitForShell,
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

const SECTION_A = 'section.section >> nth=0';
const SECTION_B = 'section.section >> nth=1';
const COLUMN_A = '[data-pk-kind="column"] >> nth=0';
const HEADING_A = `${SECTION_A} >> h2`;
const HEADING_B = `${SECTION_B} >> h2`;
const ACCORDION = '[data-accordion]';
const TRIGGER = `${ACCORDION} button`;

/** Two sections: a heading and a text; a heading, an accordion and a form, then a tall spacer. */
async function twoSections(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [
      section(heading('Alpha heading'), paragraph('Alpha text.')),
      section(
        heading('Beta heading'),
        {
          type: 'accordion',
          props: { title: 'Details', body: 'The hidden panel text.' },
        },
        { type: 'siteForm', props: { label: 'Submit form' } },
        { type: 'spacer', props: { size: 'tall' } },
      ),
    ],
  });
}

function mode(page: Page) {
  return page.locator(`${MODE_GROUP} [role="radio"][aria-checked="true"]`);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('scoped selection', () => {
  test('a click selects the deepest item, empty column space the column, empty section space the section, and an empty area clears', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        {
          type: 'section',
          props: { variant: 'plain' },
          children: [
            { type: 'column', children: [heading('Short column')] },
            {
              type: 'column',
              children: [
                heading('Tall column'),
                paragraph('Text that makes this column taller.'),
                paragraph('And more text below it.'),
              ],
            },
          ],
        },
        section(heading('Other section')),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const shortColumn = '[data-plakboek-columns] > [data-pk-block] >> nth=0';

    // a heading inside a column inside a section is one click away, and the
    // column around it becomes the scope, drawn dashed
    await frame.getByRole('heading', { name: 'Short column' }).click();
    await expectSelectedOver(page, frame, `${SECTION_A} >> h2 >> nth=0`);
    await expect(chrome(page).locator(SCOPE)).toHaveCount(1);
    const columnBox = await frame.locator(shortColumn).boundingBox();

    // below the short column's heading the column itself is under the pointer
    await frame
      .locator(shortColumn)
      .click({ position: { x: 8, y: (columnBox?.height ?? 0) - 8 } });
    await expectSelectedOver(page, frame, shortColumn);

    // the section's own padding holds no column (12px down is below the band
    // of the insert point above the first section; three quarters across is
    // clear of the selected column's toolbar and of the line between columns)
    const sectionBox = await frameBoxOf(frame, SECTION_A);
    await page.mouse.click(
      sectionBox.x + sectionBox.width * 0.75,
      sectionBox.y + 12,
    );
    await expectSelectedOver(page, frame, SECTION_A);

    // a click in another section selects its heading directly
    await frame.getByRole('heading', { name: 'Other section' }).click();
    await expectSelectedOver(page, frame, `${SECTION_B} >> h2`);

    // empty page area (the site's header holds no block) clears the selection
    await frame
      .locator('header.site-header')
      .click({ position: { x: 2, y: 2 } });
    await expect(chrome(page).locator(SELECTED)).toHaveCount(0);
  });

  test('a click on the selected block outside its text keeps it selected', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    // the heading is a text box while it is typed in, so it is found by place
    const headingA = frame.locator(HEADING_A);
    await headingA.click();
    await expectSelectedOver(page, frame, HEADING_A);

    // the far end of the heading's box holds no text
    const box = await headingA.boundingBox();
    await headingA.click({
      position: { x: (box?.width ?? 0) - 8, y: (box?.height ?? 0) / 2 },
    });
    await expectSelectedOver(page, frame, HEADING_A);
  });

  test('a double-click opens nothing, not even on a heading', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    await frame.getByRole('heading', { name: 'Alpha heading' }).dblclick();

    await expectSelectedOver(page, frame, HEADING_A);
    await expect(
      page.locator(`${HOST} [data-properties-sheet][data-open]`),
    ).toHaveCount(0);
  });

  test('Escape climbs one level at a time and clears at a top-level section', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await selectItem(page, frame.locator(HEADING_A).first());
    await expectSelectedOver(page, frame, HEADING_A);

    await page.keyboard.press('Escape');
    await expectSelectedOver(page, frame, COLUMN_A);
    await page.keyboard.press('Escape');
    await expectSelectedOver(page, frame, SECTION_A);
    await page.keyboard.press('Escape');
    await expect(chrome(page).locator(SELECTED)).toHaveCount(0);
  });
});

test.describe('Edit mode claims the site', () => {
  test('a click selects and does not follow a link, toggle an accordion, scroll to a hash or submit a form', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const framedUrl = frame.url();
    const shellUrl = page.url();
    const state = async () => ({
      handled: await frame.evaluate(() => document.body.dataset.handled),
      url: frame.url(),
      expanded: await frame.locator(TRIGGER).getAttribute('aria-expanded'),
    });

    // the accordion's button selects the accordion instead of opening
    await frame.locator(TRIGGER).click();
    await expectSelectedOver(page, frame, ACCORDION);
    expect(await state()).toMatchObject({ expanded: 'false' });

    // a link of the site's header clears the selection (the claim took the
    // click and read it as one on empty page) and does nothing else
    // The second section's heading is selected, because the first sits right
    // under the header and its toolbar would cover the links being clicked.
    for (const control of ['#handled-link', '#hash-link']) {
      await frame.getByRole('heading', { name: 'Beta heading' }).click();
      await expectSelectedOver(page, frame, HEADING_B);
      const scrolled = await frame.evaluate(() => window.scrollY);
      await frame.locator(control).click();
      await expect(chrome(page).locator(SELECTED)).toHaveCount(0);
      // the hash link would have scrolled the long page to the footer
      expect(await frame.evaluate(() => window.scrollY)).toBe(scrolled);
    }

    // the submit button of a form in the other section selects the form and
    // the form does not submit
    await frame.getByRole('heading', { name: 'Alpha heading' }).click();
    await expectSelectedOver(page, frame, HEADING_A);
    await frame.locator('#site-form-submit').click();
    await expectSelectedOver(page, frame, '#site-form');

    expect(await state()).toEqual({
      handled: undefined,
      url: framedUrl,
      expanded: 'false',
    });
    expect(page.url()).toBe(shellUrl);
  });
});

test.describe('Edit and Interact', () => {
  test('the toggle hands the site back and Edit keeps the site as it was left', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await expect(mode(page)).toHaveText('Edit');
    await selectItem(page, frame.locator(HEADING_B));
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);

    // I switches to Interact: nothing is selected, the iframe is in the tab
    // order again and the site behaves as it does for a visitor
    await page.keyboard.press('i');
    await expect(mode(page)).toHaveText('Interact');
    await expect(chrome(page).locator(SELECTED)).toHaveCount(0);
    await expect(page.locator(FRAME)).not.toHaveAttribute('tabindex');
    await expect(page.locator(LIVE_REGION)).toHaveText('Interact mode.');
    await expect(page.locator(`${HOST} [data-tools] p`)).toContainText(
      'as a visitor would',
    );
    await frame.locator(TRIGGER).click();
    await expect(frame.locator(TRIGGER)).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // back in Edit the accordion is still open and its panel can be selected
    await page.keyboard.press('i');
    await expect(mode(page)).toHaveText('Edit');
    await expect(page.locator(FRAME)).toHaveAttribute('tabindex', '-1');
    await expect(page.locator(LIVE_REGION)).toHaveText('Edit mode.');
    await expect(frame.locator(TRIGGER)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const panel = frame.getByText('The hidden panel text.');
    await expect(panel).toBeVisible();
    await selectItem(page, panel);
    await expectSelectedOver(page, frame, ACCORDION);
  });

  test('the segments are a radiogroup the arrow keys move through', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const group = page.locator(MODE_GROUP);
    await expect(group).toHaveAttribute('aria-label', 'Mode');
    await expect(mode(page)).toHaveText('Edit');

    await page.locator(`${MODE_GROUP} [role="radio"]`).first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(mode(page)).toHaveText('Interact');
    await expect(page.locator(FRAME)).not.toHaveAttribute('tabindex');
    await page.keyboard.press('ArrowLeft');
    await expect(mode(page)).toHaveText('Edit');
    await expect(page.locator(FRAME)).toHaveAttribute('tabindex', '-1');
  });

  test('the keys do nothing while typing in a field', async ({ page }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    // an input in the shell's own document stands in for a properties field
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'typing-probe';
      document.body.append(input);
      input.focus();
    });
    await page.keyboard.type('i');
    await expect(mode(page)).toHaveText('Edit');
    await expect(page.locator('#typing-probe')).toHaveValue('i');
  });
});

test.describe('a user who cannot edit', () => {
  test('keeps the read-only shell: no tool group, no claim, the site works', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await signIn(page, e2eUsers().viewer);
    await page.goto('/?_edit=1');
    await waitForShell(page);
    const frame = await framedSite(page);

    await expect(page.locator(`${HOST} [data-tools]`)).toHaveCount(0);
    await expect(page.locator(MODE_GROUP)).toHaveCount(0);
    await expect(page.locator(HOST)).not.toHaveAttribute('data-session');
    await expect(page.locator(FRAME)).not.toHaveAttribute('tabindex');

    // nothing claims the click, so the accordion opens as for a visitor
    await frame.locator(TRIGGER).first().click();
    await expect(frame.locator(TRIGGER).first()).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(chrome(page).locator(SELECTED)).toHaveCount(0);
  });
});
