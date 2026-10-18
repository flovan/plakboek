import type { ReactElement } from 'react';
import {
  displayNameOf,
  RAIL_CONTROL,
  skipToPage,
  useLeaveGuard,
  type LeaveHandler,
  type SidebarEditing,
  type SidebarLayout,
  type SidebarSlots,
} from './controls.js';
import {
  ExitIcon,
  ExpandIcon,
  FrameIcon,
  LogOutIcon,
  SpinnerIcon,
} from './icons.js';
import type { ShellIsland } from './island.js';
import { STAGE_ID } from './stage.js';
import { STRINGS } from './strings.js';
import { Tooltip } from './tooltip.js';

export type RailProps = {
  readonly island: ShellIsland;
  readonly slots?: SidebarSlots;
  /** The editing tools of the rail; absent for a user who cannot edit. */
  readonly editing?: SidebarEditing;
  /** The toggle only works once the client has hydrated. */
  readonly hydrated: boolean;
  /** The layout the shell is in now, for the toggle's pressed state. */
  readonly layout: SidebarLayout;
  readonly onToggleLayout?: () => void;
  /** Called by Exit edit mode and Log out before they leave; it calls `proceed` to go. */
  readonly onLeave?: LeaveHandler;
};

/** The rail's own layer: hidden, nudged left, until the host is in the full
 * layout, then shown in place. Both layers are always in the markup, so the
 * server's first paint and the client's first render agree whichever layout a
 * browser stored; the host attribute decides which one is seen. Under reduced
 * motion there is no transition and the swap is instant.
 *
 * The layer being shown leaves `visibility` out of its transition, so it is
 * visible, and its toggle can take focus, the moment the attribute changes; a
 * transition from hidden to visible would still be hidden at its start. The
 * layer being hidden keeps `visibility` in, so it stays visible through its
 * fade. */
const RAIL_BODY =
  'invisible absolute inset-0 flex min-h-0 flex-col items-center p-2 opacity-0 translate-x-2 motion-safe:transition-[opacity,translate,visibility] motion-safe:duration-240 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:[:host([data-layout=full])_&]:transition-[opacity,translate] [:host([data-layout=full])_&]:visible [:host([data-layout=full])_&]:translate-x-0 [:host([data-layout=full])_&]:opacity-100';

/** The first letter of the name, or of the email when there is no name. */
function initialOf(displayName: string): string {
  return Array.from(displayName.trim())[0]?.toUpperCase() ?? '';
}

/**
 * The 56px rail of the full-width layout: the same controls as the sidebar's
 * footer as 40px icon buttons, each with an `aria-label` equal to its
 * expanded label and a tooltip, an avatar circle for the user, and the
 * navigation slot called for the full layout. The product name is read by
 * assistive technology only.
 */
export function Rail(props: RailProps): ReactElement {
  const { island, slots, editing, hydrated, layout, onToggleLayout, onLeave } =
    props;
  const { leaving, onExitClick, onLogoutSubmit } = useLeaveGuard(onLeave);
  const displayName = displayNameOf(island.user);
  const pressed = layout === 'full';
  return (
    <div className={RAIL_BODY} data-rail="">
      <a
        href={`#${STAGE_ID}`}
        onClick={skipToPage}
        className="sr-only rounded-lg bg-surface px-3 py-2 text-body font-semibold whitespace-nowrap text-text focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {STRINGS['sidebar.skipLink']}
      </a>
      <span className="sr-only">{STRINGS['product.name']}</span>
      {editing?.rail}
      <div data-slot="nav" className="min-h-0 w-full flex-1 overflow-y-auto">
        {slots?.nav?.({ layout: 'full' })}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-border pt-2">
        <Tooltip label={STRINGS['sidebar.fullWidth']}>
          <button
            type="button"
            aria-label={STRINGS['sidebar.fullWidth']}
            data-layout-toggle=""
            aria-pressed={pressed}
            disabled={!hydrated}
            onClick={onToggleLayout}
            className={RAIL_CONTROL}
          >
            {pressed ? <ExpandIcon /> : <FrameIcon />}
          </button>
        </Tooltip>
        <Tooltip
          label={
            leaving === 'exit'
              ? STRINGS['loading.saving']
              : STRINGS['sidebar.exit']
          }
        >
          <a
            href={island.visitorLocation}
            onClick={onExitClick}
            aria-disabled={leaving === 'exit' ? true : undefined}
            aria-label={
              leaving === 'exit'
                ? STRINGS['loading.saving']
                : STRINGS['sidebar.exit']
            }
            className={RAIL_CONTROL}
          >
            {leaving === 'exit' ? <SpinnerIcon /> : <ExitIcon />}
          </a>
        </Tooltip>
        <Tooltip label={displayName}>
          <div
            role="img"
            aria-label={displayName}
            className="flex size-8 items-center justify-center rounded-full bg-surface-muted text-body font-semibold text-text"
          >
            {initialOf(displayName)}
          </div>
        </Tooltip>
        <form
          method="post"
          action={island.logoutPath}
          onSubmit={onLogoutSubmit}
          className="m-0"
        >
          <input type="hidden" name="next" value={island.visitorLocation} />
          <Tooltip
            label={
              leaving === 'logout'
                ? STRINGS['loading.saving']
                : STRINGS['sidebar.logOut']
            }
          >
            <button
              type="submit"
              aria-disabled={leaving === 'logout' ? true : undefined}
              aria-label={
                leaving === 'logout'
                  ? STRINGS['loading.saving']
                  : STRINGS['sidebar.logOut']
              }
              className={RAIL_CONTROL}
            >
              {leaving === 'logout' ? <SpinnerIcon /> : <LogOutIcon />}
            </button>
          </Tooltip>
        </form>
      </div>
    </div>
  );
}
