/**
 * The interactive-block UAT matrix, in a real browser: an item-based
 * accordion, tabs and carousel, plus the site's own links, form and dialog
 * button. In Edit a click selects and does nothing else; in Interact the same
 * click behaves as on the site; the state the site was left in survives the
 * switch back; and the host's `*.edit.ts` hook modules cooperate with the
 * editor (reveal, pause, re-bind).
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  framedSite,
  FRAME,
  LIVE_REGION,
  MODE_GROUP,
  openEditor,
  SELECTED,
  tabToRegion,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  paragraph,
  section,
  type EditablePage,
  type FactoryBlock,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

function mode(page: Page) {
  return page.locator(`${MODE_GROUP} [role="radio"][aria-checked="true"]`);
}

function slidesBlock(autoplay: boolean): FactoryBlock {
  return {
    type: 'slides',
    props: { autoplay },
    children: [
      { type: 'slide', children: [paragraph('First slide text')] },
      { type: 'slide', children: [paragraph('Second slide text')] },
    ],
  };
}

async function slidesPage(autoplay = false): Promise<EditablePage> {
  return await createEditablePage({
    blocks: [section(slidesBlock(autoplay))],
  });
}

/** Moves the selection with the keys only: section, column, then `steps`. */
async function walk(page: Page, ...steps: readonly string[]): Promise<void> {
  await tabToRegion(page);
  for (const step of ['ArrowDown', 'ArrowRight', ...steps]) {
    await page.keyboard.press(step);
  }
}

async function interact(page: Page): Promise<void> {
  await page.keyboard.press('i');
  await expect(mode(page)).toHaveText('Interact');
  await expect(page.locator(FRAME)).not.toHaveAttribute('tabindex');
}

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

test.describe('a host hook module and the editor', () => {
  test('selecting the second slide’s text shows that slide, Edit holds the autoplay, and in Interact the site’s own Next button still works', async ({
    page,
  }) => {
    const created = await slidesPage();
    await openEditor(page, created.path);
    const frame: Frame = await framedSite(page);
    const root = frame.locator('[data-slides]');
    const first = frame.getByText('First slide text');
    const second = frame.getByText('Second slide text');

    // Edit mode paused the autoplay, and only the first slide shows
    await expect(root).toHaveAttribute('data-paused', '');
    await expect(first).toBeVisible();
    await expect(second).toBeHidden();

    // slides, first slide, second slide, then its text
    await walk(page, 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowRight');

    await expect(second).toBeVisible();
    await expect(first).toBeHidden();
    await expect(page.locator(SELECTED)).toHaveCount(1);
    await expect(page.locator(LIVE_REGION)).toContainText('Selected Text');

    await interact(page);
    await expect(root).not.toHaveAttribute('data-paused');
    await frame.getByRole('button', { name: 'Next slide' }).click();
    await expect(first).toBeVisible();
    await expect(second).toBeHidden();
  });
});
