/**
 * Proof that a host theme's own interactive components work, on a top-level
 * page or inside an iframe alike: accordion, carousel, sticky header, a
 * window scroll listener, a fixed bottom banner and a site-owned dialog.
 */
import { expect, type Frame } from '@playwright/test';

type SiteWindow = Window & {
  __siteScriptsReady?: boolean;
  __siteScrollEvents?: number;
};

const SCROLL_TARGET = 800;

export async function assertSiteBehaviour(frame: Frame): Promise<void> {
  await frame.waitForFunction(
    () => (window as SiteWindow).__siteScriptsReady === true,
  );

  // Accordion: opens, then closes.
  const trigger = frame.locator('[data-accordion] button').first();
  const panel = frame.locator('[data-accordion] [role="region"]').first();
  await expect(panel).toBeHidden();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();

  // Carousel: next moves the track to index 1.
  const track = frame.locator('[data-carousel-track]').first();
  await expect(track).toHaveAttribute('data-index', '0');
  await frame.locator('[data-carousel-next]').first().click();
  await expect(track).toHaveAttribute('data-index', '1');

  // Site dialog: opens as a modal, then closes.
  const dialog = frame.locator('#site-dialog');
  await frame.locator('#open-site-dialog').click();
  await expect
    .poll(() => dialog.evaluate((element) => element.matches(':modal')))
    .toBe(true);
  await frame.locator('#close-site-dialog').click();
  await expect
    .poll(() =>
      dialog.evaluate((element) => (element as HTMLDialogElement).open),
    )
    .toBe(false);

  // Window scroll: the frame's own window scrolls, the scroll listener sees
  // it, the sticky header stays pinned and the fixed banner stays at the
  // bottom of the frame's viewport.
  await frame.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Scroll events are delivered on the next frame: let those of the earlier
  // interactions land before counting.
  await frame.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const eventsBefore = await frame.evaluate(
    () => (window as SiteWindow).__siteScrollEvents ?? 0,
  );
  await frame.evaluate(
    (top) => window.scrollTo({ top, behavior: 'instant' }),
    SCROLL_TARGET,
  );
  await expect
    .poll(() => frame.evaluate(() => document.body.dataset.scrolled))
    .toBe('true');
  const scrollY = await frame.evaluate(() => window.scrollY);
  expect(scrollY).toBeGreaterThan(0);
  await expect
    .poll(() =>
      frame.evaluate(() => (window as SiteWindow).__siteScrollEvents ?? 0),
    )
    .toBeGreaterThan(eventsBefore);

  const headerTop = await frame
    .locator('header.site-header')
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(headerTop)).toBeLessThanOrEqual(1);

  const { bannerBottom, viewportHeight } = await frame.evaluate(() => {
    const banner = document.querySelector('.cookie-banner');
    return {
      bannerBottom: banner?.getBoundingClientRect().bottom ?? Number.NaN,
      viewportHeight: window.innerHeight,
    };
  });
  expect(Math.abs(bannerBottom - viewportHeight)).toBeLessThanOrEqual(1);
}
