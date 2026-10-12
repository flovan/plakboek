import { expect, test } from '@playwright/test';
import { assertSiteBehaviour } from './helpers/site-behaviour.ts';

test.describe('anonymous visitor on the adversarial theme', () => {
  test('the host theme interactivity works through the real CMS', async ({
    page,
  }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(await response?.text()).not.toContain('plakboek-editor');

    await assertSiteBehaviour(page.mainFrame());

    // Third-party analytics still runs for visitors.
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __analyticsFired?: boolean }).__analyticsFired,
      ),
    ).toBe(true);
  });

  test('/clean links the clean stylesheet and no hostile one', async ({
    page,
  }) => {
    const response = await page.goto('/clean');
    expect(response?.status()).toBe(200);
    const html = (await response?.text()) ?? '';
    expect(html).toContain('/clean.css');
    expect(html).not.toContain('/theme.css');
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).fontSize,
      ),
    ).not.toBe('10px');
  });
});
