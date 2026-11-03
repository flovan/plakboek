/**
 * A text block with no box of its own, in a real browser. The host block
 * renders its field as the block root with no height when it is empty, so the
 * pointer has to reach it through the ghost box its outline is drawn from,
 * wherever it sits in its column: last in the column, or alone in a section.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  framedSite,
  frameBoxOf,
  HOST,
  openEditor,
  selectedId,
} from './helpers/editing.ts';
import { e2eUsers } from './helpers/host.ts';
import {
  createEditablePage,
  heading,
  readBlockProps,
  section,
  type FactoryBlock,
} from './helpers/pages.ts';
import { signIn } from './helpers/session.ts';

const BARE = '[data-pk-type="bareText"]';
const bareText: FactoryBlock = { type: 'bareText', props: {} };

test.beforeEach(async ({ page }) => {
  await signIn(page, e2eUsers().editor);
});

async function open(
  page: Page,
  blocks: readonly FactoryBlock[],
): Promise<{ frame: Frame; pageId: string; id: string }> {
  const created = await createEditablePage({ blocks });
  await openEditor(page, created.path);
  const frame = await framedSite(page);
  const id = await frame.locator(BARE).getAttribute('data-pk-block');
  if (id === null) throw new Error('The bare text block is not on the page');
  return { frame, pageId: created.pageId, id };
}

/** A point 40px in and 8px down from the field's top-left, inside its ghost box. */
async function ghostPoint(frame: Frame): Promise<{ x: number; y: number }> {
  const box = await frameBoxOf(frame, BARE);
  expect(box.height).toBe(0);
  return { x: box.x + 40, y: box.y + 8 };
}

test.describe('an empty text with no box of its own', () => {
  test('is selected by one click when it ends its column, and typed in', async ({
    page,
  }) => {
    const { frame, pageId, id } = await open(page, [
      section(heading('H1'), bareText),
    ]);
    const { x, y } = await ghostPoint(frame);

    await page.mouse.click(x, y);

    await expect.poll(() => selectedId(page)).toBe(id);
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await page.keyboard.type('Hello');
    await expect(frame.locator(BARE)).toHaveText('Hello');
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    await expect
      .poll(async () =>
        JSON.stringify((await readBlockProps(pageId, 'bareText')).body),
      )
      .toContain('Hello');
  });

  test('is selected by one click when it is alone in a new section', async ({
    page,
  }) => {
    const { frame, id } = await open(page, [section(bareText)]);
    const { x, y } = await ghostPoint(frame);

    await page.mouse.click(x, y);

    await expect.poll(() => selectedId(page)).toBe(id);
  });

  test('is entered with Enter from the page region', async ({ page }) => {
    const { frame, id } = await open(page, [section(heading('H1'), bareText)]);
    const { x, y } = await ghostPoint(frame);

    await page.mouse.click(x, y);
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
    await expect.poll(() => selectedId(page)).toBe(id);

    await page.keyboard.press('Enter');
    await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
    await page.keyboard.type('Again');
    await expect(frame.locator(BARE)).toHaveText('Again');
  });
});
