/**
 * Opening the edit shell and reading what the editor drew, for the specs that
 * select and edit. A spec signs in first (`signIn`), then `openEditor` waits
 * until the editing session is running: the page opened, the lock taken and
 * the frame's clicks claimed.
 */
import { expect, type Frame, type Page } from '@playwright/test';

export const HOST = 'plakboek-editor';
export const FRAME = `${HOST} iframe`;
export const SELECTED = `${HOST} [data-overlay-selected]`;
export const SCOPE = `${HOST} [data-overlay-scope]`;
export const OUTLINE = `${HOST} [data-overlay-outline]`;
export const SECTION_OUTLINE = `${HOST} [data-overlay-section]`;
export const CHIP = `${HOST} [data-overlay-chip]`;
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
 * frame's clicks are claimed (the frame leaves the tab order only then).
 */
export async function openEditor(page: Page, path: string): Promise<void> {
  const separator = path.includes('?') ? '&' : '?';
  const response = await page.goto(`${path}${separator}_edit=1`);
  expect(response?.status()).toBe(200);
  await waitForShell(page);
  await expect(page.locator(HOST)).toHaveAttribute('data-session', 'editing');
  await expect(page.locator(FRAME)).toHaveAttribute('tabindex', '-1');
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
  await expect(page.locator(SELECTED)).toHaveCount(1);
  await expect
    .poll(async () => {
      const outline = await page.locator(SELECTED).first().boundingBox();
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
