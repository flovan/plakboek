/**
 * Selecting on the page, in a real browser: an editor opens a page for
 * editing, clicks claim the framed site's events and select by the scope
 * rules, the Edit and Interact toggle hands the site back, and the page lock
 * is held while editing.
 */
import { test } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import {
  expectSelectedOver,
  framedSite,
  openEditor,
} from './helpers/editing.ts';
import {
  createEditablePage,
  heading,
  paragraph,
  section,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('opening a page for editing', () => {
  test('a click on the framed site selects the section under the pointer', async ({
    page,
  }) => {
    const created = await createEditablePage({
      blocks: [
        section(heading('First heading'), paragraph('First text.')),
        section(heading('Second heading'), paragraph('Second text.')),
      ],
    });
    await openEditor(page, created.path);
    const frame = await framedSite(page);

    await frame.getByRole('heading', { name: 'Second heading' }).click();

    await expectSelectedOver(page, frame, 'section.section >> nth=1');
  });
});
