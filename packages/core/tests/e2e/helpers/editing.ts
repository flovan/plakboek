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
 * Lets a spec reach the chrome the editor draws inside the framed document.
 * That chrome sits in a closed shadow root, which Playwright locators cannot
 * enter, so this init script makes `attachShadow` create open roots, but only
 * in documents whose address carries `_edit=frame`. The gate is read when
 * `attachShadow` is called, not when the script is installed: the frame's
 * first window is an `about:blank` one that the real document reuses. Product
 * code never sees this patch, and the isolation spec runs without it.
 */
export async function exposeFrameChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const marker = Symbol.for('plakboek.e2e.openFrameChrome');
    const proto = Element.prototype as unknown as Record<symbol, boolean>;
    if (proto[marker] === true) return;
    proto[marker] = true;
    const original = Reflect.get(Element.prototype, 'attachShadow') as (
      this: Element,
      init: ShadowRootInit,
    ) => ShadowRoot;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const forced = location.search.includes('_edit=frame');
      return original.call(this, forced ? { ...init, mode: 'open' } : init);
    };
  });
}

/**
 * Opens `<path>?_edit=1` and waits until the editing session runs and the
 * frame's clicks are claimed (the frame leaves the tab order only then). Locks
 * an earlier spec left on a shared page are released first. The chrome inside
 * the frame is reachable (see `exposeFrameChrome`) unless `exposeChrome` is
 * false.
 */
export async function openEditor(
  page: Page,
  path: string,
  options: { readonly exposeChrome?: boolean } = {},
): Promise<void> {
  await releaseAllPageLocks();
  if (options.exposeChrome !== false) await exposeFrameChrome(page);
  const separator = path.includes('?') ? '&' : '?';
  const response = await page.goto(`${path}${separator}_edit=1`);
  expect(response?.status()).toBe(200);
  await waitForShell(page);
  await expect(page.locator(HOST)).toHaveAttribute('data-session', 'editing');
  await expect(page.locator(FRAME)).toHaveAttribute('tabindex', '-1');
}

/** The tag of the in-frame chrome host. */
export const FRAME_CHROME = 'plakboek-chrome';

/**
 * The scope of frame-anchored chrome: the outlines, chips, block toolbar,
 * insert points, picker, needs-input markers and empty prompts. It lives in
 * the chrome host inside the framed document, which a spec reaches because
 * `openEditor` makes that root open (see `exposeFrameChrome`). Specs reach all
 * of it through here. What stays in the shell (the drag capture surface and
 * label, the toast, the sidebar and the Properties sheet) is reached with
 * `page.locator(HOST)`.
 */
export function chrome(page: Page): Locator {
  return page.frameLocator(FRAME).locator(FRAME_CHROME);
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
 * Selects the item the target belongs to with one click on the target: a click
 * selects the deepest item under the pointer, so the target should be the
 * item's own content (its text), not a nested block inside it.
 */
export async function selectItem(page: Page, target: Locator): Promise<void> {
  const id = await target.evaluate(
    (element) =>
      element.closest('[data-pk-block]')?.getAttribute('data-pk-block') ?? null,
  );
  if (id === null) throw new Error('The target is not inside a block');
  await target.click();
  // A click on editable text also starts a field session; it is left again
  // (the block stays selected) so the specs that only select are not typing.
  if ((await page.locator(HOST).getAttribute('data-text-field')) !== null) {
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  }
  await expect.poll(() => selectedId(page)).toBe(id);
}

/**
 * Clicks a text field the way an editor does (one click selects the block and
 * puts the caret under the pointer), waits for the field session, and types.
 * `position` is relative to the target's top-left corner.
 */
export async function typeInField(
  page: Page,
  target: Locator,
  text: string,
  position?: { readonly x: number; readonly y: number },
): Promise<void> {
  await target.click(position === undefined ? {} : { position });
  await expect(page.locator(HOST)).toHaveAttribute('data-text-field', '');
  await page.keyboard.type(text);
}

/**
 * Selects a section or a column. A click selects the deepest item under the
 * pointer, so a container is reached the way an editor reaches it: click what
 * is inside it, then Escape climbs one level at a time until it is selected.
 * The target is the container's own element and the click lands on its centre.
 */
export async function selectContainer(
  page: Page,
  target: Locator,
): Promise<void> {
  const id = await target.getAttribute('data-pk-block');
  if (id === null) throw new Error('The target is not a block');
  await target.click();
  // A click on editable text also starts a field session; leaving it first
  // keeps the first Escape from being spent on the field.
  if ((await page.locator(HOST).getAttribute('data-text-field')) !== null) {
    await page.keyboard.press('Escape');
    await expect(page.locator(HOST)).not.toHaveAttribute('data-text-field', '');
  }
  for (let climbs = 0; climbs < 6; climbs += 1) {
    await expect.poll(() => selectedId(page)).not.toBeNull();
    const current = await selectedId(page);
    if (current === id) return;
    await page.keyboard.press('Escape');
    await expect.poll(() => selectedId(page)).not.toBe(current);
  }
  await expect.poll(() => selectedId(page)).toBe(id);
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
