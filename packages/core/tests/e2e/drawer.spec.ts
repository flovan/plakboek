/**
 * The full-width layout's rail tools and panel drawer, in a real browser: the
 * drawer pushes the framed site narrower instead of covering it, and everything
 * an editor needs (mode, undo, redo, save status, Blocks, Properties) works from
 * the rail.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  FRAME,
  framedSite,
  HOST,
  openEditor,
  SELECTED,
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
  test('opens beside the rail and pushes the frame narrower instead of covering it, and closing restores it', async ({
    page,
  }) => {
    await openFullWidth(page);
    const frame = await framedSite(page);
    const target = frame.locator('section.section').first().locator('h2');
    const before = await page.locator(FRAME).boundingBox();
    expect(before?.x).toBeCloseTo(56, 0);

    await target.dblclick();
    await target.dblclick();
    await expect(page.locator(SELECTED)).toHaveCount(1);

    await railButton(page, 'Properties').click();
    await expect(page.locator(DRAWER)).toBeVisible();

    const drawer = await page.locator(DRAWER).boundingBox();
    const pushed = await page.locator(FRAME).boundingBox();
    expect(drawer?.width).toBeCloseTo(280, 0);
    expect(pushed?.x).toBeCloseTo((before?.x ?? 0) + 280, 0);
    expect(pushed?.width).toBeCloseTo((before?.width ?? 0) - 280, 0);
    // nothing of the drawer is drawn over the site
    expect((drawer?.x ?? 0) + (drawer?.width ?? 0)).toBeLessThanOrEqual(
      (pushed?.x ?? 0) + 1,
    );
    // the site reflowed to the narrower viewport, once
    expect(await frame.evaluate(() => window.innerWidth)).toBeCloseTo(
      (before?.width ?? 0) - 280,
      0,
    );

    // the selection is still on the heading, and its Properties are right here
    await expect(page.locator(SELECTED)).toHaveCount(1);
    const text = page.locator(DRAWER).getByRole('textbox', { name: 'Text' });
    await expect(text).toHaveValue('Hello');
    await text.press('End');
    await text.pressSequentially(' there');
    await expect(target).toHaveText('Hello there', { timeout: 1000 });

    await railButton(page, 'Properties').click();
    await expect(page.locator(DRAWER)).toBeHidden();
    const restored = await page.locator(FRAME).boundingBox();
    expect(restored?.x).toBeCloseTo(before?.x ?? 0, 0);
    expect(restored?.width).toBeCloseTo(before?.width ?? 0, 0);
    await expect(page.locator(SELECTED)).toHaveCount(1);
    await expect(target).toHaveText('Hello there');
  });
});

test.describe('the drawer at the edges', () => {
  test('still opens as a drawer in the narrowest window, and the frame keeps well over its minimum', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openFullWidth(page);

    await railButton(page, 'Blocks').click();
    await expect(page.locator(DRAWER)).toBeVisible();
    await expect(page.locator(HOST)).toHaveAttribute('data-layout', 'full');
    const frame = await page.locator(FRAME).boundingBox();
    expect(frame?.width).toBeCloseTo(1024 - 56 - 280, 0);
  });

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

    await railButton(page, 'Blocks').click();
    await expect(page.locator(DRAWER)).toBeVisible();
    expect((await focusIn(page)).inDrawer).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator(DRAWER)).toBeHidden();
    expect(await focusIn(page)).toEqual({
      inDrawer: false,
      railButton: 'blocks',
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

    await railButton(page, 'Blocks').click();
    await expect(page.locator(DRAWER)).toBeVisible();
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(600);

    // a press in the middle of the pushed frame selects, and the drawer stays
    const box = await page.locator(FRAME).boundingBox();
    await page.mouse.click(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await expect(page.locator(SELECTED)).toHaveCount(1);
    await expect(page.locator(DRAWER)).toBeVisible();

    await railButton(page, 'Blocks').click();
    await expect(page.locator(DRAWER)).toBeHidden();
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBe(600);
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

    await frame.locator('section.section h2').first().dblclick();
    await page.getByRole('button', { name: /^Duplicate / }).click();
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
      await tabB.goto(`${created.path}?_edit=1`);
      await waitForShell(tabB);
      await expect(tabB.locator(HOST)).toHaveAttribute(
        'data-session',
        'editing',
      );
      await switchToFullWidth(tabB);

      // tab A writes first, so tab B's write is refused as stale
      const frameA = await framedSite(tabA);
      await frameA.locator('section.section h2').nth(1).dblclick();
      await frameA.locator('section.section h2').nth(1).dblclick();
      await tabA.getByRole('button', { name: /^Move .* down$/ }).click();
      await expect(tabA.getByText('All changes saved')).toBeVisible();

      const frameB = await framedSite(tabB);
      await frameB.locator('section.section h2').nth(1).dblclick();
      await frameB.locator('section.section h2').nth(1).dblclick();
      await tabB.getByRole('button', { name: /^Move .* down$/ }).click();

      const properties = railButton(tabB, 'Properties');
      await expect(properties).toHaveAccessibleName(/new notice/);
      await expect(tabB.locator(`${HOST} [data-rail-dot]`)).toHaveCount(1);

      await railButton(tabB, 'Blocks').click();
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
