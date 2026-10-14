/**
 * Rearranging on the page, in a real browser: the floating toolbar's move
 * buttons and the keyboard model turn into one autosaved write each, the frame
 * is patched in place, undo and redo apply the inverse and forward writes, and
 * a failed save leaves the page as it was and can be retried.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  expectSelectedOver,
  framedSite,
  HOST,
  openEditor,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const TOOLBAR = `${HOST} [role="toolbar"]`;
const SAVED = 'All changes saved';

/** Section A: a column with H1 and H2. Section B: a column with H3. */
async function twoSections(publish = false): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(heading('H1'), heading('H2')), section(heading('H3'))],
    publish,
  });
}

function headingsIn(frame: Frame, sectionIndex: number): Promise<string[]> {
  return frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .allTextContents();
}

/** Double-click twice: section to column, column to the block under the pointer. */
async function drillTo(frame: Frame, sectionIndex: number, at: number) {
  const target = frame
    .locator('section.section')
    .nth(sectionIndex)
    .locator('h2')
    .nth(at);
  await target.dblclick();
  await target.dblclick();
}

/** Tabs from the top of the shell until the page region has focus. */
async function tabToRegion(page: Page): Promise<void> {
  for (let presses = 0; presses < 30; presses += 1) {
    if (await regionFocused(page)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('The page region never took focus');
}

function regionFocused(page: Page): Promise<boolean> {
  return page
    .locator(`${HOST} #plakboek-stage`)
    .evaluate(
      (element) =>
        element.getRootNode() instanceof ShadowRoot &&
        (element.getRootNode() as ShadowRoot).activeElement === element,
    );
}

function moveButton(page: Page, direction: string) {
  return page.getByRole('button', {
    name: new RegExp(`^Move .* ${direction}$`),
  });
}

async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText(SAVED)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('moving by the toolbar', () => {
  test('Move down on the last heading of a column lands it at the top of the next column, saved and still there after a reload', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 1);
    await expectSelectedOver(
      page,
      frame,
      'section.section >> nth=0 >> h2 >> nth=1',
    );
    await expect(page.locator(TOOLBAR)).toBeVisible();

    await moveButton(page, 'down').click();

    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
    expect(await headingsIn(frame, 0)).toEqual(['H1']);
    await expectSaved(page);
    // the moved heading stays selected, in its new place
    await expectSelectedOver(
      page,
      frame,
      'section.section >> nth=1 >> h2 >> nth=0',
    );

    await page.reload();
    const reloaded = await framedSite(page);
    await expect.poll(() => headingsIn(reloaded, 1)).toEqual(['H2', 'H3']);
    expect(await headingsIn(reloaded, 0)).toEqual(['H1']);
  });
});

test.describe('moving by the keyboard', () => {
  test('the whole move is done without a pointer, crossing into the next section, and focus stays in the region', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    await tabToRegion(page);
    await page.keyboard.press('ArrowDown'); // the first section
    await page.keyboard.press('ArrowRight'); // its column
    await page.keyboard.press('ArrowRight'); // H1
    await expectSelectedOver(
      page,
      frame,
      'section.section >> nth=0 >> h2 >> nth=0',
    );

    await page.keyboard.press('Alt+ArrowDown'); // past H2
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H2', 'H1']);
    await page.keyboard.press('Alt+ArrowDown'); // into the next section
    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H1', 'H3']);
    expect(await headingsIn(frame, 0)).toEqual(['H2']);
    await expectSaved(page);
    expect(await regionFocused(page)).toBe(true);

    await page.reload();
    const reloaded = await framedSite(page);
    await expect.poll(() => headingsIn(reloaded, 1)).toEqual(['H1', 'H3']);
  });

  test('Alt+Arrow at the first block of the first section says so and changes nothing', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await tabToRegion(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await page.keyboard.press('Alt+ArrowUp');

    await expect(page.locator(`${HOST} [data-live-region]`)).toHaveText(
      'Already at the start',
    );
    expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
  });
});

test.describe('the toolbar buttons', () => {
  test('Move up at the very start is aria-disabled and gives its reason', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 0);

    const up = moveButton(page, 'up');
    await expect(up).toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.locator(`${TOOLBAR} [data-tooltip]`, {
        hasText: 'Already at the start',
      }),
    ).toHaveCount(1);
    // an aria-disabled button stays clickable; the click must do nothing
    await up.click({ force: true });
    expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    await expect(moveButton(page, 'down')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  test('columns that sit side by side move left and right', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        {
          type: 'section',
          props: { variant: 'plain' },
          children: [
            { type: 'column', children: [heading('Left')] },
            { type: 'column', children: [heading('Right')] },
          ],
        },
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    // double-click a heading: the section's column under the pointer
    await frame.getByRole('heading', { name: 'Left' }).dblclick();

    await expect(moveButton(page, 'right')).toBeVisible();
    await expect(moveButton(page, 'left')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(moveButton(page, 'down')).toHaveCount(0);
  });
});

test.describe('undo and redo', () => {
  test('undo restores the order, saved, and it stays restored after a reload', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 1);
    await moveButton(page, 'down').click();
    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
    await expectSaved(page);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    await expectSaved(page);
    await expect(page.locator(`${HOST} [data-live-region]`)).toContainText(
      'Undone: Moved',
    );

    await page.reload();
    const reloaded = await framedSite(page);
    await expect.poll(() => headingsIn(reloaded, 0)).toEqual(['H1', 'H2']);
    expect(await headingsIn(reloaded, 1)).toEqual(['H3']);
  });

  test('redo applies the move again, saved, and it stays applied after a reload', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 1);
    await moveButton(page, 'down').click();
    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
    await expectSaved(page);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    await expectSaved(page);

    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
    await expectSaved(page);
    await expect(page.locator(`${HOST} [data-live-region]`)).toContainText(
      'Redone: Moved',
    );

    await page.reload();
    const reloaded = await framedSite(page);
    await expect.poll(() => headingsIn(reloaded, 1)).toEqual(['H2', 'H3']);
    // the history is the session's: a reload starts with nothing to undo
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('the frame keeps its scroll position through a move and an undo', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(heading('H1'), heading('H2')),
        section(
          heading('H3'),
          { type: 'spacer', props: { size: 'tall' } },
          { type: 'spacer', props: { size: 'tall' } },
        ),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await tabToRegion(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await frame.evaluate(() => window.scrollTo(0, 300));
    const scrolled = await frame.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);

    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H2', 'H1']);
    await expectSaved(page);
    expect(await frame.evaluate(() => window.scrollY)).toBe(scrolled);

    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    await expectSaved(page);
    expect(await frame.evaluate(() => window.scrollY)).toBe(scrolled);
  });
});

test.describe('what visitors see', () => {
  test('a visitor still receives the published order after the working tree was rearranged', async ({
    page,
  }) => {
    const created = await twoSections(true);
    const visitorOrder = async (): Promise<string[]> => {
      const response = await page.request.get(created.path);
      expect(response.status()).toBe(200);
      const html = await response.text();
      return [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(
        (match) => match[1] ?? '',
      );
    };
    const before = await visitorOrder();
    expect(before).toEqual(['H1', 'H2', 'H3']);

    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 0);
    await moveButton(page, 'down').click();
    await expect.poll(() => headingsIn(frame, 0)).toEqual(['H2', 'H1']);
    await expectSaved(page);

    expect(await visitorOrder()).toEqual(before);
  });
});

test.describe('a save that does not go through', () => {
  const EDIT_ROUTE = '**/cms/api/pages/*/edit';

  test('a network failure keeps the old order and shows Retry, and Retry saves the move', async ({
    page,
  }) => {
    // the write retries three times with backoff before it gives up
    test.setTimeout(60_000);
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 1);
    await page.route(EDIT_ROUTE, (route) => route.abort());

    await moveButton(page, 'down').click();

    const alert = page.getByRole('alert').filter({
      hasText: 'Could not save your changes',
    });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    expect(await headingsIn(frame, 1)).toEqual(['H3']);

    await page.unroute(EDIT_ROUTE);
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
    await expectSaved(page);
  });

  test('a refused move leaves the page alone and offers no Retry', async ({
    page,
  }) => {
    const created = await twoSections();
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    await drillTo(frame, 0, 1);
    await page.route(EDIT_ROUTE, (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'placement' } }),
      }),
    );

    await moveButton(page, 'down').click();

    const alert = page.getByRole('alert').filter({
      hasText: 'Could not save your changes',
    });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    expect(await headingsIn(frame, 0)).toEqual(['H1', 'H2']);
    expect(await headingsIn(frame, 1)).toEqual(['H3']);
  });
});
