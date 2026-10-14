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
  paragraph,
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

test.describe('taking over', () => {
  test('an editor with wider permissions takes a page, and the holder is then told and made read-only', async ({
    browser,
  }) => {
    const created = await twoSections();
    // Take over needs a permission superset: an editor covers one who may not delete.
    const holder = await personIn(
      browser,
      { roleKey: 'editor-no-delete', name: 'Hal Holder' },
      { clock: true },
    );
    const taker = await personIn(browser, {
      roleKey: 'editor',
      name: 'Tess Taker',
    });
    try {
      await openEditor(holder.page, created.path);
      await openShell(taker.page, created.path);
      await expect(taker.page.locator(HOST)).toHaveAttribute(
        'data-session',
        'locked',
      );

      await taker.page.getByRole('button', { name: 'Take over' }).click();
      const dialog = taker.page.getByRole('dialog', {
        name: 'Take over editing?',
      });
      await expect(dialog).toContainText(
        'Hal Holder will lose editing access to this page.',
      );
      await expect(
        dialog.getByRole('button', { name: 'Cancel' }),
      ).toBeFocused();
      await dialog.getByRole('button', { name: 'Take over' }).click();

      // the taker edits now, and is not told that anyone "stopped"
      await expect(taker.page.locator(HOST)).toHaveAttribute(
        'data-session',
        'editing',
      );
      await expect(taker.page.locator(MODE_GROUP)).toBeVisible();
      await expect(taker.page.locator(NOTICE)).toHaveCount(0);

      // the editor finds out at the next heartbeat
      await holder.page.clock.fastForward(BEAT_MS);
      await expect(holder.page.locator(HOST)).toHaveAttribute(
        'data-session',
        'locked',
      );
      const alert = holder.page.getByRole('alert').filter({
        hasText: 'Tess Taker took over this page',
      });
      await expect(alert).toContainText('Everything saved so far is kept.');
      await expect(holder.page.locator(TOOLS)).toHaveCount(0);
    } finally {
      await holder.context.close();
      await taker.context.close();
    }
  });

  test('an editor whose permissions do not cover the holder is not offered Take over', async ({
    browser,
  }) => {
    const created = await twoSections();
    const holder = await personIn(browser, {
      roleKey: 'editor',
      name: 'Hal Holder',
    });
    const other = await personIn(browser, {
      roleKey: 'editor-no-delete',
      name: 'Wim Waiting',
    });
    try {
      await openEditor(holder.page, created.path);
      await openShell(other.page, created.path);
      await expect(
        other.page.locator(`${NOTICE}[data-notice="locked"]`),
      ).toContainText('Hal Holder is editing this page');
      await expect(
        other.page.getByRole('button', { name: 'Take over' }),
      ).toHaveCount(0);
    } finally {
      await holder.context.close();
      await other.context.close();
    }
  });
});

test.describe('conflicts and a lock that cannot be renewed', () => {
  test('a write from a second tab of the same editor pauses saving until the page is reloaded', async ({
    browser,
  }) => {
    const created = await twoSections();
    const editor = await personIn(browser, {
      roleKey: 'editor',
      name: 'Edie Editor',
    });
    try {
      const tabA = editor.page;
      await openEditor(tabA, created.path);
      const tabB = await editor.context.newPage();
      await openShell(tabB, created.path);
      await expect(tabB.locator(HOST)).toHaveAttribute(
        'data-session',
        'editing',
      );

      await moveSecondHeadingDown(tabA);

      const frameB = await framedSite(tabB);
      await drillTo(frameB, 0, 1);
      await tabB.getByRole('button', { name: /^Move .* down$/ }).click();
      const alert = tabB.getByRole('alert').filter({
        hasText: 'This page changed elsewhere',
      });
      await expect(alert).toContainText('It was edited in another tab');
      await expect(tabB.getByText('Saving is paused')).toBeVisible();
      // the page was not changed by the refused write
      expect(await headingsIn(frameB, 0)).toEqual(['H1', 'H2']);

      await alert.getByRole('button', { name: 'Reload page' }).click();
      await waitForShell(tabB);
      const reloaded = await framedSite(tabB);
      await expect.poll(() => headingsIn(reloaded, 1)).toEqual(['H2', 'H3']);
      await expect(tabB.locator(NOTICE)).toHaveCount(0);
    } finally {
      await editor.context.close();
    }
  });

  test('a write after the session ended says so and offers to sign in again', async ({
    browser,
  }) => {
    const created = await twoSections();
    const editor = await personIn(browser, {
      roleKey: 'editor',
      name: 'Edie Editor',
    });
    try {
      await openEditor(editor.page, created.path);
      await editor.context.clearCookies();

      const frame = await framedSite(editor.page);
      await drillTo(frame, 0, 1);
      await editor.page.getByRole('button', { name: /^Move .* down$/ }).click();

      const alert = editor.page.getByRole('alert').filter({
        hasText: 'Your session ended',
      });
      await expect(alert).toContainText('Your saved changes are kept.');
      await expect(
        alert.getByRole('link', { name: 'Sign in' }),
      ).toHaveAttribute(
        'href',
        `/cms?next=${encodeURIComponent(created.path)}`,
      );
    } finally {
      await editor.context.close();
    }
  });

  test('renewals that fail show when editing access ends, announce it, and Keep editing renews', async ({
    browser,
  }) => {
    const created = await twoSections();
    const editor = await personIn(
      browser,
      { roleKey: 'editor', name: 'Edie Editor' },
      { clock: true },
    );
    try {
      await openEditor(editor.page, created.path);
      const row = editor.page.locator(`${HOST} [data-lock-expiry]`);
      await expect(row).toHaveCount(0);

      const renewals = '**/cms/api/pages/*/lock/renew';
      await editor.page.route(renewals, (route) => route.abort());
      await editor.page.clock.fastForward(BEAT_MS);
      await expect(row).toContainText('Editing access ends in');
      // a minute left is said once, in the live region
      await editor.page.clock.fastForward(BEAT_MS);
      await expect(
        editor.page.locator(`${HOST} [role="status"].sr-only`),
      ).toContainText('Editing access ends in 1:00');

      await editor.page.unroute(renewals);
      await row.getByRole('button', { name: 'Keep editing' }).click();
      await expect(row).toHaveCount(0);
    } finally {
      await editor.context.close();
    }
  });
});

test.describe('leaving with something unsaved', () => {
  const EDITS = '**/cms/api/pages/*/edit';

  /** Opens a page with a heading "Hello", types into its text control and leaves the write unsent. */
  async function typeIntoHeading(page: Page): Promise<EditablePage> {
    const created = await createEditablePage({
      blocks: [section(heading('Hello'), paragraph('Below'))],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);
    const target = frame.locator('section.section >> h2').first();
    await target.dblclick();
    await target.dblclick();
    await target.dblclick();
    const control = page.getByRole('textbox', { name: 'Text' });
    await expect(control).toHaveValue('Hello');
    await control.press('End');
    await control.pressSequentially(' there');
    return created;
  }

  test('Exit edit mode saves first, says so while it does, and then leaves', async ({
    browser,
  }) => {
    const editor = await personIn(browser, {
      roleKey: 'editor',
      name: 'Edie Editor',
    });
    try {
      const { page } = editor;
      // a slow save, so the control can be seen waiting for it
      await page.route(EDITS, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.continue();
      });
      const created = await typeIntoHeading(page);

      await page.getByRole('link', { name: 'Exit edit mode' }).click();
      await expect(page.getByRole('link', { name: 'Saving' })).toBeVisible();
      await page.waitForURL(`**${created.path}`);
      expect(new URL(page.url()).search).toBe('');

      await page.unroute(EDITS);
      await openEditor(page, created.path);
      const frame = await framedSite(page);
      await expect(frame.locator('section.section >> h2').first()).toHaveText(
        'Hello there',
      );
    } finally {
      await editor.context.close();
    }
  });

  test('a save that fails asks before leaving, and Stay keeps the page while Leave anyway goes without a second prompt', async ({
    browser,
  }) => {
    const editor = await personIn(browser, {
      roleKey: 'editor',
      name: 'Edie Editor',
    });
    try {
      const { page } = editor;
      const prompts: string[] = [];
      page.on('dialog', (dialog) => {
        prompts.push(dialog.type());
        void dialog.dismiss();
      });
      await page.route(EDITS, (route) => route.abort());
      const created = await typeIntoHeading(page);

      await page.getByRole('link', { name: 'Exit edit mode' }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Leave without saving?',
      });
      await expect(dialog).toContainText(
        'Your latest changes could not be saved.',
      );
      await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused();
      await dialog.getByRole('button', { name: 'Stay' }).click();
      await expect(dialog).toHaveCount(0);
      // focus is back on the control that asked to leave
      await expect(
        page.getByRole('link', { name: 'Exit edit mode' }),
      ).toBeFocused();
      await expect(page.locator(HOST)).toHaveAttribute(
        'data-session',
        'editing',
      );
      expect(page.url()).toContain('_edit=1');

      await page.getByRole('link', { name: 'Exit edit mode' }).click();
      await page
        .getByRole('dialog', { name: 'Leave without saving?' })
        .getByRole('button', { name: 'Leave anyway' })
        .click();
      await page.waitForURL(`**${created.path}`);
      expect(prompts).toEqual([]);
    } finally {
      await editor.context.close();
    }
  });

  test('closing the page with a change not yet saved raises the browser prompt', async ({
    browser,
  }) => {
    const editor = await personIn(browser, {
      roleKey: 'editor',
      name: 'Edie Editor',
    });
    try {
      const { page } = editor;
      await page.route(EDITS, (route) => route.abort());
      await typeIntoHeading(page);
      await expect(page.getByText('Could not save your changes')).toBeVisible();

      // closing with the unload handlers run does not wait for the page, so the prompt is awaited
      const prompt = page.waitForEvent('dialog');
      await page.close({ runBeforeUnload: true });
      const dialog = await prompt;
      expect(dialog.type()).toBe('beforeunload');
      await dialog.dismiss();
    } finally {
      await editor.context.close();
    }
  });
});
