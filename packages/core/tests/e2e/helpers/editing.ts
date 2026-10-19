/**
 * Opening the edit shell and reading what the editor drew, for the specs that
 * select and edit. A spec signs in first (`signIn`), then `openEditor` waits
 * until the editing session is running: the page opened, the lock taken and
 * the frame's clicks claimed.
 */
import { expect, type Frame, type Locator, type Page } from '@playwright/test';
import { releaseAllPageLocks } from './pages.ts';

export const HOST = 'plakboek-editor';
export const FRAME = `${HOST} iframe`;
export const SELECTED = '[data-overlay-selected]';
export const SCOPE = '[data-overlay-scope]';
export const OUTLINE = '[data-overlay-outline]';
export const SECTION_OUTLINE = '[data-overlay-section]';
export const CHIP = '[data-overlay-chip]';
export const MODE_GROUP = `${HOST} [role="radiogroup"]`;
export const LIVE_REGION = `${HOST} [role="status"].sr-only`;

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export async function framedSite(page: Page): Promise<Frame> {
  const handle = await page.locator(FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) {
    throw new Error('The shell has no framed document');
  }
  return frame;
}

/** Waits for the shell to hydrate and the framed site to finish loading. */
export async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator(HOST)).toHaveAttribute('data-hydrated', '');
  const frame = await framedSite(page);
  await frame.waitForFunction(
    () =>
      document.readyState === 'complete' &&
      (window as Window & { __siteScriptsReady?: boolean })
        .__siteScriptsReady === true,
  );
}

/**
 * Opens `<path>?_edit=1` and waits until the editing session runs and the
 * frame's clicks are claimed (the frame leaves the tab order only then). Locks
 * an earlier spec left on a shared page are released first.
 */
export async function openEditor(page: Page, path: string): Promise<void> {
  await releaseAllPageLocks();
  const separator = path.includes('?') ? '&' : '?';
  const response = await page.goto(`${path}${separator}_edit=1`);
  expect(response?.status()).toBe(200);
  await waitForShell(page);
  await expect(page.locator(HOST)).toHaveAttribute('data-session', 'editing');
  await expect(page.locator(FRAME)).toHaveAttribute('tabindex', '-1');
}

/**
 * The scope of frame-anchored chrome: the outlines, chips, block toolbar,
 * insert points, picker, needs-input markers and empty prompts. Specs reach
 * all of it through here so that moving it (plan 09-16 points it into the
 * frame) changes this one function.
 */
export function chrome(page: Page): Locator {
  return page.locator(HOST);
}

/** A chrome element's box in the page's coordinates. */
export async function chromeBoxOf(page: Page, selector: string): Promise<Rect> {
  const box = await chrome(page).locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box in the chrome`);
  return box;
}

/** The id of the selected item: the selected outline's value, null when none. */
export async function selectedId(page: Page): Promise<string | null> {
  const outline = chrome(page).locator(SELECTED);
  if ((await outline.count()) === 0) return null;
  const value = await outline.first().getAttribute('data-overlay-selected');
  return value === null || value === '' ? null : value;
}

/**
 * Selects the item the target belongs to. Phase 8 drills: a click selects the
 * section, each further double-click goes one level in (an accordion
 * entry's text is four levels down). Plan 09-14 makes it one click, and only
 * this function changes.
 */
export async function selectItem(page: Page, target: Locator): Promise<void> {
  const id = await target.evaluate(
    (element) =>
      element.closest('[data-pk-block]')?.getAttribute('data-pk-block') ?? null,
  );
  if (id === null) throw new Error('The target is not inside a block');
  let current = await selectedId(page);
  await target.click();
  current = await settledSelection(page, current);
  for (let drills = 0; drills < 4 && current !== id; drills += 1) {
    const previous = current;
    await target.dblclick();
    current = await settledSelection(page, previous);
  }
  await expect.poll(() => selectedId(page)).toBe(id);
}

/** Waits briefly for the selection to move off `previous`, then reads it. */
async function settledSelection(
  page: Page,
  previous: string | null,
): Promise<string | null> {
  await expect
    .poll(() => selectedId(page), { timeout: 750 })
    .not.toBe(previous)
    .catch(() => undefined);
  return await selectedId(page);
}

/** Selects the item and opens its Properties sheet from the block toolbar. */
export async function openProperties(
  page: Page,
  target: Locator,
): Promise<void> {
  await selectItem(page, target);
  await chrome(page)
    .getByRole('button', { name: /^Properties of / })
    .click();
  await expect(
    page.locator(`${HOST} [data-properties-sheet][data-open]`),
  ).toHaveCount(1);
}

export async function boxOf(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box in the shell`);
  return box;
}

/** A frame element's box in the page's coordinates. */
export async function frameBoxOf(
  frame: Frame,
  selector: string,
): Promise<Rect> {
  const box = await frame.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box in the frame`);
  return box;
}

export function expectNear(actual: Rect, expected: Rect, tolerance = 1): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(
    tolerance,
  );
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(
    tolerance,
  );
}

/** Waits until the selected outline sits over the frame element's box. */
export async function expectSelectedOver(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<void> {
  await expect(chrome(page).locator(SELECTED)).toHaveCount(1);
  await expect
    .poll(async () => {
      const outline = await chrome(page)
        .locator(SELECTED)
        .first()
        .boundingBox();
      const element = await frame.locator(selector).first().boundingBox();
      if (outline === null || element === null) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(outline.x - element.x),
        Math.abs(outline.y - element.y),
        Math.abs(outline.width - element.width),
        Math.abs(outline.height - element.height),
      );
    })
    .toBeLessThanOrEqual(1);
}

export function regionFocused(page: Page): Promise<boolean> {
  return page
    .locator(`${HOST} #plakboek-stage`)
    .evaluate(
      (element) =>
        element.getRootNode() instanceof ShadowRoot &&
        (element.getRootNode() as ShadowRoot).activeElement === element,
    );
}

/** Tabs from the top of the shell until the page region has focus. */
export async function tabToRegion(page: Page): Promise<void> {
  for (let presses = 0; presses < 30; presses += 1) {
    if (await regionFocused(page)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('The page region never took focus');
}
