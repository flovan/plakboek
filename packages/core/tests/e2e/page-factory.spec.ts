/**
 * The page factory the mutating specs build on: a spec creates its own page
 * through the engine and opens it in edit mode.
 */
import { expect, test } from '@playwright/test';
import { e2eUsers } from './helpers/host.ts';
import { createEditablePage, heading, section } from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

test('a spec can create its own page and open it in edit mode', async ({
  page,
}) => {
  const created = await createEditablePage({
    blocks: [section(heading('Factory heading'))],
  });
  await signIn(page, e2eUsers().editor);

  const response = await page.goto(`${created.path}?_edit=1`);
  expect(response?.status()).toBe(200);
  await expect(
    page
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Factory heading' }),
  ).toBeVisible();
});
