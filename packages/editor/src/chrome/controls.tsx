import { EDITOR_FLAG_KEY } from '@plakboek/render';
import type { MouseEvent, ReactNode } from 'react';
import { STAGE_ID } from './stage.js';

/** The two layouts of the shell: a 280px sidebar with the page framed, or a
 * 56px rail with the page flush. */
export type SidebarLayout = 'framed' | 'full';

/** What a later release fills the sidebar with. Phase 7 renders no item. */
export type SidebarSlots = {
  /** The navigation region between the product name and the footer. It is
   * called with the layout it is drawn for, so items render icon-only in the
   * rail, and it renders nothing when absent. */
  readonly nav?: (context: { readonly layout: SidebarLayout }) => ReactNode;
};

/**
 * What the sidebar shows while a page is being edited, in this order between
 * the product name and the navigation slot. A read-only shell has none.
 */
export type SidebarEditing = {
  /** Banners about the page's state (lock, paused saving). */
  readonly notice: ReactNode;
  /** The mode toggle and the save status. */
  readonly tools: ReactNode;
  /** The side panel: blocks and properties. */
  readonly panel: ReactNode;
};

/** The selector prefix that styles an element by the host's layout. It makes
 * a utility apply only while the host element carries `data-layout="full"`.
 * Tailwind reads class names as literal source text, so every use below
 * spells the whole class out. */
export const WHEN_FULL = '[:host([data-layout=full])_&]';

/** The button and anchor style of the framed sidebar: full width, 40px. */
export const CONTROL =
  'flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text no-underline hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-surface-muted';

/** The same control in the rail: a 40px square holding one icon. */
export const RAIL_CONTROL =
  'flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-control-border bg-surface p-0 text-text no-underline hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-surface-muted';

/** An anchor to an id inside a shadow root does not navigate there, so the
 * skip link moves focus itself once the client is running. */
export function skipToPage(event: MouseEvent<HTMLAnchorElement>): void {
  const root = event.currentTarget.getRootNode();
  if (!(root instanceof ShadowRoot)) return;
  const stage = root.getElementById(STAGE_ID);
  if (stage === null) return;
  event.preventDefault();
  stage.focus();
}

/** The text a user is shown as: their name, or their email without one. */
export function displayNameOf(user: {
  readonly name: string;
  readonly email: string;
}): string {
  return user.name.trim() === '' ? user.email : user.name;
}

/**
 * The Log out form's submit handler. It forgets that an editor signed in on
 * this browser, so the Edit pill no longer shows on visitor pages, and lets
 * the form's own POST carry on: the session itself is ended by the server. The
 * flag is a hint with no authority, so a failure to clear it (storage blocked)
 * changes nothing that matters, and without a script the flag simply stays and
 * the pill with it.
 */
export function forgetEditorFlag(): void {
  try {
    globalThis.localStorage.removeItem(EDITOR_FLAG_KEY);
  } catch {
    // Storage is blocked or missing: there was no flag to clear.
  }
}
