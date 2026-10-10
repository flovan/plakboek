import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  CONTROL,
  displayNameOf,
  skipToPage,
  type SidebarLayout,
  type SidebarSlots,
} from './controls.js';
import { ExitIcon, ExpandIcon, FrameIcon, LogOutIcon } from './icons.js';
import type { ShellIsland } from './island.js';
import { Rail } from './rail.js';
import { STAGE_ID } from './stage.js';
import { STRINGS } from './strings.js';
import { Tooltip } from './tooltip.js';

export type { SidebarLayout, SidebarSlots } from './controls.js';

export type SidebarProps = {
  readonly island: ShellIsland;
  readonly slots?: SidebarSlots;
  /** The toggle only works once the client has hydrated. */
  readonly hydrated: boolean;
  /** The layout the shell is in now, for the toggle's pressed state. */
  readonly layout: SidebarLayout;
  readonly onToggleLayout?: () => void;
};

/** The framed layer: shown in place until the host is in the full layout,
 * then hidden and nudged left. See the rail's layer for why both are always
 * in the markup. */
const SIDEBAR_BODY =
  'visible absolute inset-0 flex min-h-0 flex-col p-4 opacity-100 motion-safe:transition-[opacity,translate,visibility] motion-safe:duration-240 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] [:host([data-layout=full])_&]:invisible [:host([data-layout=full])_&]:-translate-x-2 [:host([data-layout=full])_&]:opacity-0';

/** The user's name, clamped to two lines; once the client is running, a
 * clamped name also carries a tooltip with the whole of it. */
function UserName(props: { readonly name: string }): ReactElement {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element !== null) {
      setClamped(element.scrollHeight > element.clientHeight + 1);
    }
  }, [props.name]);
  return (
    <Tooltip label={props.name} className="block" enabled={clamped}>
      <p
        ref={ref}
        className="m-0 line-clamp-2 text-body font-semibold text-text wrap-anywhere"
      >
        {props.name}
      </p>
    </Tooltip>
  );
}

/**
 * The editor sidebar and, beside it in the same element, the rail of the
 * full-width layout. Exit edit mode is a real anchor and Log out a real form
 * post, so both work before any script has run; the frame toggle is disabled
 * until hydration. Nothing here carries an inline style: sizes and layout
 * come from classes.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const { island, slots, hydrated, layout, onToggleLayout } = props;
  const displayName = displayNameOf(island.user);
  const pressed = layout === 'full';
  return (
    <aside
      aria-label={STRINGS['landmark.sidebar']}
      className="pk-sidebar relative overflow-visible"
    >
      <div className={SIDEBAR_BODY} data-sidebar="">
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
          {slots?.nav?.({ layout: 'framed' })}
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-4">
          <button
            type="button"
            aria-pressed={pressed}
            disabled={!hydrated}
            onClick={onToggleLayout}
            className={CONTROL}
          >
            {pressed ? <ExpandIcon /> : <FrameIcon />}
            {STRINGS['sidebar.fullWidth']}
          </button>
          <a href={island.visitorLocation} className={CONTROL}>
            <ExitIcon />
            {STRINGS['sidebar.exit']}
          </a>
          <div className="mt-2 flex flex-col gap-2">
            <UserName name={displayName} />
            <form method="post" action={island.logoutPath} className="m-0">
              <input type="hidden" name="next" value={island.visitorLocation} />
              <button type="submit" className={CONTROL}>
                <LogOutIcon />
                {STRINGS['sidebar.logOut']}
              </button>
            </form>
          </div>
        </div>
      </div>
      <Rail
        island={island}
        slots={slots}
        hydrated={hydrated}
        layout={layout}
        onToggleLayout={onToggleLayout}
      />
    </aside>
  );
}
