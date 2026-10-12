/**
 * The shell's layout preference: framed (the default) or full width, kept per
 * browser in `localStorage`. The pre-paint script in the shell document reads
 * the same key before first paint; this module is the browser-side reader and
 * writer. Storage can be missing or throw (privacy modes), and none of that
 * may break the shell, so every access is guarded and a failed read means
 * framed.
 */
import type { SidebarLayout } from '../../chrome/controls.js';

/** Must equal `LAYOUT_STORAGE_KEY` of the server's pre-paint script; a unit
 * test holds the two together. */
export const LAYOUT_KEY = 'plakboek:editor-layout';

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): LayoutStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    // Reading `localStorage` itself can throw when storage is blocked.
    return null;
  }
}

/** The stored layout; anything but exactly `full` means framed. */
export function readLayout(
  storage: LayoutStorage | null = defaultStorage(),
): SidebarLayout {
  try {
    return storage?.getItem(LAYOUT_KEY) === 'full' ? 'full' : 'framed';
  } catch {
    return 'framed';
  }
}

/** Stores the layout. A failure is ignored: the choice then lasts until the
 * page is left. */
export function writeLayout(
  value: SidebarLayout,
  storage: LayoutStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(LAYOUT_KEY, value);
  } catch {
    // Not persisted; the layout still applies for this page.
  }
}

/** Puts the layout on the host element, which the chrome stylesheet's
 * `:host([data-layout])` rules read. */
export function applyLayout(host: HTMLElement, value: SidebarLayout): void {
  host.setAttribute('data-layout', value);
}

/** The layout the host element currently shows. */
export function layoutOf(host: HTMLElement): SidebarLayout {
  return host.getAttribute('data-layout') === 'full' ? 'full' : 'framed';
}
