/**
 * Page locks and conflicts, in a real browser with two people: the read-only
 * shell and banner for a page someone else holds, the hand-over when they
 * leave, taking over, being taken over, a second tab of the same editor, an
 * ended session, a lock that cannot be renewed, and leaving with something
 * unsaved. The heartbeat and poll intervals are moved with the page's clock.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from '@playwright/test';
import {
  framedSite,
  FRAME,
  HOST,
  MODE_GROUP,
  openEditor,
  SELECTED,
  waitForShell,
} from './helpers/editing.ts';
import {
  createEditablePage,
  heading,
  releaseAllPageLocks,
  section,
  type EditablePage,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';
import { createTestUser, type TestUser } from './helpers/users.ts';

const NOTICE = `${HOST} [data-notice]`;
const TOOLS = `${HOST} [data-tools]`;
/// A little more than the heartbeat interval (30 seconds).
const BEAT_MS = 31_000;

/** Section A: a column with H1 and H2. Section B: a column with H3. */
async function twoSections(): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(heading('H1'), heading('H2')), section(heading('H3'))],
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

/** H2 moves to the top of the next column, and the write is saved. */
async function moveSecondHeadingDown(page: Page): Promise<void> {
  const frame = await framedSite(page);
  await drillTo(frame, 0, 1);
  await page.getByRole('button', { name: /^Move .* down$/ }).click();
  await expect.poll(() => headingsIn(frame, 1)).toEqual(['H2', 'H3']);
  await expect(page.getByText('All changes saved')).toBeVisible();
}

type Person = {
  readonly user: TestUser;
  readonly context: BrowserContext;
  readonly page: Page;
};

/** A signed-in person in a browser context of their own. */
async function personIn(
  browser: Browser,
  input: { readonly roleKey: string; readonly name: string },
  options: { readonly clock?: boolean } = {},
): Promise<Person> {
  const user = await createTestUser(input);
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  if (options.clock === true) await page.clock.install();
  await signIn(page, user);
  return { user, context, page };
}

async function openShell(page: Page, path: string): Promise<void> {
  const response = await page.goto(`${path}?_edit=1`);
  expect(response?.status()).toBe(200);
  await waitForShell(page);
}

test.beforeEach(async () => {
  await releaseAllPageLocks();
});

test.describe('a page someone else holds', () => {
  test('opens read-only with who and since when, and hands itself over when they leave without losing their work', async ({
    browser,
  }) => {
    const created = await twoSections();
    const holder = await personIn(browser, {
      roleKey: 'editor',
      name: 'Hedy Holder',
    });
    const waiting = await personIn(
      browser,
      { roleKey: 'editor', name: 'Wim Waiting' },
      { clock: true },
    );
    try {
      await openEditor(holder.page, created.path);
      await moveSecondHeadingDown(holder.page);

      await openShell(waiting.page, created.path);
      await expect(waiting.page.locator(HOST)).toHaveAttribute(
        'data-session',
        'locked',
      );
      const notice = waiting.page.locator(`${NOTICE}[data-notice="locked"]`);
      await expect(notice).toContainText('Hedy Holder is editing this page');
      await expect(notice).toContainText('Last active');
      // only the name and the time: no address, no role
      const text = (await notice.textContent()) ?? '';
      expect(text).not.toContain(holder.user.email);
      expect(text).not.toMatch(/editor/i);
      // read-only: no tools, no claim, a click selects nothing
      await expect(waiting.page.locator(TOOLS)).toHaveCount(0);
      await expect(waiting.page.locator(FRAME)).not.toHaveAttribute('tabindex');
      const frame = await framedSite(waiting.page);
      await frame.locator('section.section h2').first().click();
      await expect(waiting.page.locator(SELECTED)).toHaveCount(0);

      // the holder leaves; the waiting editor's next poll finds the page free
      await holder.page.goto('/about');
      await expect(async () => {
        await waiting.page.clock.fastForward(BEAT_MS);
        await expect(waiting.page.locator(HOST)).toHaveAttribute(
          'data-session',
          'editing',
          { timeout: 2000 },
        );
      }).toPass({ timeout: 20_000 });
      await expect(
        waiting.page.locator(`${NOTICE}[data-notice="lapsed"]`),
      ).toContainText(
        'Hedy Holder stopped editing. You can edit this page now.',
      );
      await expect(waiting.page.locator(MODE_GROUP)).toBeVisible();
      // the holder's saved move is in the page the new editor sees
      const reloaded = await framedSite(waiting.page);
      await expect.poll(() => headingsIn(reloaded, 1)).toEqual(['H2', 'H3']);
    } finally {
      await holder.context.close();
      await waiting.context.close();
    }
  });
});
