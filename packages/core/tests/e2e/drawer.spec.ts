/**
 * The full-width layout's rail tools and panel drawer, in a real browser:
 * everything an editor needs (mode, undo, redo, save status, Page structure,
 * Properties) works from the rail and the drawer beside it.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  chrome,
  exposeFrameChrome,
  FRAME,
  framedSite,
  HOST,
  openEditor,
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
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';
import { createTestUser } from './helpers/users.ts';

const RAIL = `${HOST} [data-rail]`;
const DRAWER = `${HOST} [data-drawer-panel]`;
const FRAMED_TOGGLE = `${HOST} [data-sidebar] [data-layout-toggle]`;

/** The rail's own buttons, by their accessible name. */
function railButton(page: Page, name: string | RegExp) {
  return page.locator(RAIL).getByRole('button', { name });
}

function headings(frame: Frame): Promise<string[]> {
  return frame.locator('section.section h2').allTextContents();
}

/** Which of the drawer's or the rail's elements holds keyboard focus. */
function focusIn(
  page: Page,
): Promise<{ inDrawer: boolean; railButton: string }> {
  return page.locator(HOST).evaluate((host) => {
    const active = host.shadowRoot?.activeElement ?? null;
    return {
      inDrawer: active?.closest('[data-drawer-panel]') != null,
      railButton: active?.getAttribute('data-rail-button') ?? '',
    };
  });
}

async function switchToFullWidth(page: Page): Promise<void> {
  await page.locator(FRAMED_TOGGLE).click();
  await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
}

/** Opens a page with a heading "Hello" in the full-width layout. */
async function openFullWidth(page: Page): Promise<void> {
  const created = await createEditablePage({
    blocks: [section(heading('Hello'), paragraph('Below'))],
  });
  await openEditor(page, created.path);
  await switchToFullWidth(page);
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('the panel drawer', () => {
  test('opens beside the rail, edits the selection, and closing keeps it', async ({
    page,
  }) => {
    await openFullWidth(page);
    const frame = await framedSite(page);
    const target = frame.locator('section.section').first().locator('h2');

    await selectItem(page, target);
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);

    await railButton(page, 'Properties').click();
    await expect(page.locator(DRAWER)).toBeVisible();

    // the selection is still on the heading, and its Properties are right here
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
    const text = page.locator(DRAWER).getByRole('textbox', { name: 'Text' });
    await expect(text).toHaveValue('Hello');
    await text.press('End');
    await text.pressSequentially(' there');
    await expect(target).toHaveText('Hello there', { timeout: 1000 });

    await railButton(page, 'Properties').click();
    await expect(page.locator(DRAWER)).toBeHidden();
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
    await expect(target).toHaveText('Hello there');
  });
});

test.describe('the drawer at the edges', () => {
  test('switches to the sidebar layout with the sheet open when the pushed frame would be under 320px wide', async ({
    page,
  }) => {
    await openFullWidth(page);
    // a stage that leaves the frame 590px: 280px less is 310px
    await page.locator(FRAME).evaluate((frame) => {
      frame.style.width = '590px';
    });

    await railButton(page, 'Properties').click();

    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'framed');
    await expect(page.locator(DRAWER)).toHaveCount(0);
    await expect(
      page.locator(`${HOST} [data-properties-sheet][data-open]`),
    ).toBeVisible();
  });

  test('moves focus into the drawer on open and back to the rail button on Escape', async ({
    page,
  }) => {
    await openFullWidth(page);

    await railButton(page, 'Page structure').click();
    await expect(page.locator(DRAWER)).toBeVisible();
    expect((await focusIn(page)).inDrawer).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator(DRAWER)).toBeHidden();
    expect(await focusIn(page)).toEqual({
      inDrawer: false,
      railButton: 'structure',
    });
  });

  test('stays open while a press in the frame selects, and keeps the frame scrolled where it was', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(
          heading('Top'),
          { type: 'spacer', props: { size: 'tall' } },
          heading('Bottom'),
        ),
      ],
    });
    await openEditor(page, created.path);
    await switchToFullWidth(page);
    const frame = await framedSite(page);
    await frame.evaluate(() =>
      window.scrollTo({ top: 600, behavior: 'instant' }),
    );
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(600);
    const scrolled = await frame.evaluate(() => window.scrollY);

    await railButton(page, 'Page structure').click();
    await expect(page.locator(DRAWER)).toBeVisible();
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBe(scrolled);

    // a press in the frame selects, and the drawer stays
    await frame
      .locator('body')
      .click({ position: { x: 200, y: scrolled + 200 } });
    await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
    await expect(page.locator(DRAWER)).toBeVisible();

    await railButton(page, 'Page structure').click();
    await expect(page.locator(DRAWER)).toBeHidden();
    await expect
      .poll(() => frame.evaluate(() => window.scrollY))
      .toBe(scrolled);
  });
});

test.describe('the drawer and its two layers', () => {
  test('a Properties request over Page structure and Close leave Page structure the one that shows, and the Properties button brings the sheet back', async ({
    page,
  }) => {
    await openFullWidth(page);
    const frame = await framedSite(page);
    const id = await frame
      .locator('[data-pk-type="heading"]')
      .first()
      .getAttribute('data-pk-block');
    const structure = railButton(page, 'Page structure');
    const properties = railButton(page, 'Properties');

    await structure.click();
    await page.locator(`${DRAWER} [data-tree-row="${id}"]`).dblclick();
    await expect(
      page.locator(`${DRAWER} [data-properties-sheet]`),
    ).toBeVisible();
    await expect(properties).toHaveAttribute('aria-expanded', 'true');
    await expect(structure).toHaveAttribute('aria-expanded', 'false');

    await page.locator(`${DRAWER} [data-sheet-close]`).click();
    await expect(structure).toHaveAttribute('aria-expanded', 'true');
    await expect(properties).toHaveAttribute('aria-expanded', 'false');

    await properties.click();
    await expect(
      page.locator(`${DRAWER} [data-properties-sheet]`),
    ).toBeVisible();
    await expect(page.locator(DRAWER)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(DRAWER)).toBeHidden();
    expect((await focusIn(page)).railButton).toBe('structure');
  });
});

test.describe('the rail tools', () => {
  test('the mode button hands the accordion back to the site and takes it again', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(heading('Top'), {
          type: 'accordion',
          props: { title: 'Details', body: 'The hidden panel text.' },
        }),
      ],
    });
    await openEditor(page, created.path);
    await switchToFullWidth(page);
    const frame = await framedSite(page);
    const trigger = frame.locator('[data-accordion] button').first();
    const mode = railButton(page, 'Interact mode');

    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await trigger.click();
    // Edit claims the click for selecting, so the accordion stays as it was
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('undo and redo act from the rail and the save status follows', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('H1'))],
    });
    await openEditor(page, created.path);
    await switchToFullWidth(page);
    const frame = await framedSite(page);
    const undo = railButton(page, 'Undo');
    const redo = railButton(page, 'Redo');
    await expect(undo).toHaveAttribute('aria-disabled', 'true');

    await selectItem(page, frame.locator('section.section h2').first());
    await chrome(page)
      .getByRole('button', { name: /^Duplicate / })
      .click();
    await expect.poll(() => headings(frame)).toEqual(['H1', 'H1']);
    await expect(page.locator(RAIL).getByRole('status')).toHaveText(
      'All changes saved',
    );
    await expect(undo).toHaveAttribute('aria-disabled', 'false');

    await undo.click();
    await expect.poll(() => headings(frame)).toEqual(['H1']);
    await expect(redo).toHaveAttribute('aria-disabled', 'false');

    await redo.click();
    await expect.poll(() => headings(frame)).toEqual(['H1', 'H1']);
  });
});

test.describe('a notice in the full-width layout', () => {
  test("puts a dot on the rail until the drawer is opened, and is the drawer's first element", async ({
    browser,
  }) => {
    const created = await createEditablePage({
      blocks: [section(heading('H1'), heading('H2')), section(heading('H3'))],
    });
    const editor = await createTestUser({ roleKey: 'editor' });
    const context = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
      viewport: { width: 1400, height: 900 },
    });
    try {
      const tabA = await context.newPage();
      await signIn(tabA, editor);
      await openEditor(tabA, created.path);
      const tabB = await context.newPage();
      await exposeFrameChrome(tabB);
      await tabB.goto(`${created.path}?_edit=1`);
      await waitForShell(tabB);
      await expect(tabB.locator(HOST)).toHaveAttribute(
        'data-session',
        'editing',
      );
      await switchToFullWidth(tabB);

      // tab A writes first, so tab B's write is refused as stale
      const frameA = await framedSite(tabA);
      await selectItem(tabA, frameA.locator('section.section h2').nth(1));
      await chrome(tabA)
        .getByRole('button', { name: /^Move .* down$/ })
        .click();
      await expect(tabA.getByText('All changes saved')).toBeVisible();

      const frameB = await framedSite(tabB);
      await selectItem(tabB, frameB.locator('section.section h2').nth(1));
      await chrome(tabB)
        .getByRole('button', { name: /^Move .* down$/ })
        .click();

      const properties = railButton(tabB, 'Properties');
      await expect(properties).toHaveAccessibleName(/new notice/);
      await expect(tabB.locator(`${HOST} [data-rail-dot]`)).toHaveCount(1);

      await railButton(tabB, 'Page structure').click();
      const first = tabB.locator(`${DRAWER} [data-drawer-content] > *`).first();
      await expect(first).toHaveAttribute('data-notice', 'stale');
      await expect(tabB.locator(`${HOST} [data-rail-dot]`)).toHaveCount(0);

      // with the Properties sheet over the drawer, the notice moves into it
      await railButton(tabB, 'Properties').click();
      await expect(
        tabB.locator(`${DRAWER} [data-properties-sheet] [data-notice="stale"]`),
      ).toBeVisible();
      await expect(
        tabB.locator(`${DRAWER} [data-drawer-content] [data-notice]`),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
