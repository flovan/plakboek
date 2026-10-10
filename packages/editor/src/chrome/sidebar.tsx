import type { MouseEvent, ReactElement, ReactNode } from 'react';
import { ExitIcon, FrameIcon, LogOutIcon } from './icons.js';
import type { ShellIsland } from './island.js';
import { STAGE_ID } from './stage.js';
import { STRINGS } from './strings.js';

export type SidebarLayout = 'framed' | 'full';

/** What a later release fills the sidebar with. Phase 7 renders no item. */
export type SidebarSlots = {
  /** The navigation region between the product name and the footer. It is
   * called with the current layout so items can render icon-only in a rail,
   * and it renders nothing when absent. */
  readonly nav?: (context: { readonly layout: SidebarLayout }) => ReactNode;
};

export type SidebarProps = {
  readonly island: ShellIsland;
  readonly slots?: SidebarSlots;
  /** The toggle only works once the client has hydrated. */
  readonly hydrated: boolean;
  readonly layout: SidebarLayout;
};

const CONTROL =
  'flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-control-border bg-surface px-3 text-body font-semibold text-text no-underline hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-surface-muted';

/** An anchor to an id inside a shadow root does not navigate there, so the
 * skip link moves focus itself once the client is running. */
function skipToPage(event: MouseEvent<HTMLAnchorElement>): void {
  const root = event.currentTarget.getRootNode();
  if (!(root instanceof ShadowRoot)) return;
  const stage = root.getElementById(STAGE_ID);
  if (stage === null) return;
  event.preventDefault();
  stage.focus();
}

/**
 * The editor sidebar. Exit edit mode is a real anchor and Log out a real form
 * post, so both work before any script has run; the frame toggle is disabled
 * until hydration. Nothing here carries an inline style: sizes and layout
 * come from classes.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const { island, slots, hydrated, layout } = props;
  const displayName =
    island.user.name.trim() === '' ? island.user.email : island.user.name;
  return (
    <aside aria-label={STRINGS['landmark.sidebar']} className="pk-sidebar">
      <a
        href={`#${STAGE_ID}`}
        onClick={skipToPage}
        className="sr-only rounded-lg bg-surface px-3 py-2 text-body font-semibold text-text focus:not-sr-only focus:mb-2 focus:block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {STRINGS['sidebar.skipLink']}
      </a>
      <div className="mb-2 flex h-10 shrink-0 items-center text-body font-semibold text-text">
        {STRINGS['product.name']}
      </div>
      {island.mode === 'read-only' ? (
        <div
          role="note"
          className="mb-2 shrink-0 rounded-lg border border-border p-4 text-body text-text-muted wrap-anywhere"
        >
          {STRINGS['sidebar.readOnly']}
        </div>
      ) : null}
      <div data-slot="nav" className="min-h-0 flex-1 overflow-y-auto">
        {slots?.nav?.({ layout })}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-4">
        <button
          type="button"
          aria-pressed="false"
          disabled={!hydrated}
          className={CONTROL}
        >
          <FrameIcon />
          {STRINGS['sidebar.fullWidth']}
        </button>
        <a href={island.visitorLocation} className={CONTROL}>
          <ExitIcon />
          {STRINGS['sidebar.exit']}
        </a>
        <div className="mt-2 flex flex-col gap-2">
          <p className="m-0 line-clamp-2 text-body font-semibold text-text wrap-anywhere">
            {displayName}
          </p>
          <form method="post" action={island.logoutPath} className="m-0">
            <input type="hidden" name="next" value={island.visitorLocation} />
            <button type="submit" className={CONTROL}>
              <LogOutIcon />
              {STRINGS['sidebar.logOut']}
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
