/**
 * Selecting on the page, in a real browser: an editor opens a page for
 * editing, clicks claim the framed site's events and select by the scope
 * rules, and the Edit and Interact toggle hands the site back.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  expectSelectedOver,
  framedSite,
  FRAME,
  HOST,
  LIVE_REGION,
  MODE_GROUP,
  openEditor,
  SCOPE,
  SELECTED,
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
import { createTestUser } from './helpers/users.ts';

const SECTION_A = 'section.section >> nth=0';
const SECTION_B = 'section.section >> nth=1';
const COLUMN_A = '[data-pk-kind="column"] >> nth=0';
const HEADING_A = `${SECTION_A} >> h2`;
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

/** A double-click on the element, twice: section to column, column to block. */
async function drillTwice(frame: Frame, selector: string): Promise<void> {
  const target = frame.locator(selector).first();
  await target.dblclick();
  await target.dblclick();
}

function mode(page: Page) {
  return page.locator(`${MODE_GROUP} [role="radio"][aria-checked="true"]`);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('opening a page for editing', () => {
  test('a click on the framed site selects the section under the pointer', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    await frame.getByRole('heading', { name: 'Beta heading' }).click();

    await expectSelectedOver(page, frame, SECTION_B);
    await expect(page.locator(LIVE_REGION)).toHaveText(
      'Selected Section, section 2 of 2.',
    );
  });
});

test.describe('scoped selection', () => {
  test('double-click drills from the section to its column to the block, a click in the other section climbs, and an empty area clears', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const headingA = frame.getByRole('heading', { name: 'Alpha heading' });

    // a section with one column selects that column, and the section around
    // it becomes the scope, drawn dashed
    await headingA.dblclick();
    await expectSelectedOver(page, frame, COLUMN_A);
    await expect(page.locator(SCOPE)).toHaveCount(1);
    const scope = await page.locator(SCOPE).boundingBox();
    const sectionBox = await frame.locator(SECTION_A).boundingBox();
    expect(Math.abs((scope?.x ?? 0) - (sectionBox?.x ?? 0))).toBeLessThan(2);
    expect(
      Math.abs((scope?.width ?? 0) - (sectionBox?.width ?? 0)),
    ).toBeLessThan(2);

    await headingA.dblclick();
    await expectSelectedOver(page, frame, HEADING_A);

    // a click outside the scope climbs and selects in the other section
    await frame.getByRole('heading', { name: 'Beta heading' }).click();
    await expectSelectedOver(page, frame, SECTION_B);
    await expect(page.locator(SCOPE)).toHaveCount(0);

    // empty page area (the site's header holds no block) clears the selection
    await frame
      .locator('header.site-header')
      .click({ position: { x: 2, y: 2 } });
    await expect(page.locator(SELECTED)).toHaveCount(0);
  });

  test('Escape climbs one level at a time and clears at a top-level section', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTwice(frame, HEADING_A);
    await expectSelectedOver(page, frame, HEADING_A);

    await page.keyboard.press('Escape');
    await expectSelectedOver(page, frame, COLUMN_A);
    await page.keyboard.press('Escape');
    await expectSelectedOver(page, frame, SECTION_A);
    await page.keyboard.press('Escape');
    await expect(page.locator(SELECTED)).toHaveCount(0);
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

    // the accordion's button selects its section instead of opening
    await frame.locator(TRIGGER).click();
    await expectSelectedOver(page, frame, SECTION_B);
    expect(await state()).toMatchObject({ expanded: 'false' });

    // a link of the site's header clears the selection (the claim took the
    // click and read it as one on empty page) and does nothing else
    for (const control of ['#handled-link', '#hash-link']) {
      await frame.getByRole('heading', { name: 'Alpha heading' }).click();
      await expectSelectedOver(page, frame, SECTION_A);
      const scrolled = await frame.evaluate(() => window.scrollY);
      await frame.locator(control).click();
      await expect(page.locator(SELECTED)).toHaveCount(0);
      // the hash link would have scrolled the long page to the footer
      expect(await frame.evaluate(() => window.scrollY)).toBe(scrolled);
    }

    // the submit button of a form in the other section selects that section
    // and the form does not submit
    await frame.getByRole('heading', { name: 'Alpha heading' }).click();
    await expectSelectedOver(page, frame, SECTION_A);
    await frame.locator('#site-form-submit').click();
    await expectSelectedOver(page, frame, SECTION_B);

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
    await frame.getByRole('heading', { name: 'Beta heading' }).click();
    await expect(page.locator(SELECTED)).toHaveCount(1);

    // I switches to Interact: nothing is selected, the iframe is in the tab
    // order again and the site behaves as it does for a visitor
    await page.keyboard.press('i');
    await expect(mode(page)).toHaveText('Interact');
    await expect(page.locator(SELECTED)).toHaveCount(0);
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
    await panel.dblclick();
    await panel.dblclick();
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
    await expect(page.locator(SELECTED)).toHaveCount(0);
  });
});

test.describe('the page lock while editing', () => {
  test('a second editor gets the page without the tools while the first holds it, and gets the lock once the first leaves', async ({
    page,
    browser,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);

    const second = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
      viewport: { width: 1400, height: 900 },
    });
    try {
      const other = await createTestUser({ roleKey: 'editor' });
      const page2 = await second.newPage();
      await signIn(page2, other);
      await page2.goto(`${created.path}?_edit=1`);
      await waitForShell(page2);

      // the page is shown as a visitor would see it: no tools, no claim
      await expect(page2.locator(HOST)).toHaveAttribute(
        'data-session',
        'locked',
      );
      await expect(page2.locator(`${HOST} [data-tools]`)).toHaveCount(0);
      await expect(page2.locator(FRAME)).not.toHaveAttribute('tabindex');
      // and the first editor keeps editing
      await expect(page.locator(HOST)).toHaveAttribute(
        'data-session',
        'editing',
      );
      await expect(page.locator(MODE_GROUP)).toBeVisible();

      // the first editor leaves the page: its lock is released
      await page.goto('/about');
      await expect(async () => {
        await page2.reload();
        await waitForShell(page2);
        await expect(page2.locator(HOST)).toHaveAttribute(
          'data-session',
          'editing',
          { timeout: 2000 },
        );
      }).toPass({ timeout: 20_000 });
      await expect(page2.locator(MODE_GROUP)).toBeVisible();
    } finally {
      await second.close();
    }
  });
});
