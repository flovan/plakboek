/**
 * Geometry of the full-width layout's panel drawer. The drawer is a column of
 * the shell's grid (the host's `data-drawer` attribute widens it into the
 * frame's column), so the pure rules and the one DOM step live here, away from
 * the shell's component.
 */

/** The drawer's width; the chrome stylesheet's grid column is the same number. */
export const DRAWER_WIDTH = 280;

/** The narrowest the framed site may become when the drawer pushes it. */
export const MIN_FRAME_WIDTH = 320;

/** Whether the frame, `frameWidth` wide now, still has the minimum width once the drawer is open. */
export function drawerFits(frameWidth: number): boolean {
  return frameWidth - DRAWER_WIDTH >= MIN_FRAME_WIDTH;
}

/** How long a restore waits for the frame's resize before giving up. */
const RESTORE_WAIT_MS = 300;

/**
 * Opens or closes the drawer's column on the host and keeps the framed page
 * where it was. Narrowing or widening the frame reflows the site, which can
 * move its scroll position, so the position is read first and put back when
 * the frame reports its resize; a document that became shorter clamps it.
 * Nothing changes when the host already has the state asked for.
 */
export function setDrawerColumn(
  host: HTMLElement,
  frame: HTMLIFrameElement | null,
  open: boolean,
): void {
  if ((host.getAttribute('data-drawer') === 'open') === open) return;
  const view = frame?.contentWindow ?? null;
  const top = view?.scrollY ?? 0;
  const left = view?.scrollX ?? 0;
  if (open) host.setAttribute('data-drawer', 'open');
  else host.removeAttribute('data-drawer');
  if (view === null || (top === 0 && left === 0)) return;
  const restore = (): void => {
    view.scrollTo({ top, left, behavior: 'instant' });
  };
  view.addEventListener('resize', restore, { once: true });
  globalThis.setTimeout(() => {
    view.removeEventListener('resize', restore);
  }, RESTORE_WAIT_MS);
}
