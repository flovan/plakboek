import type { ReactElement } from 'react';
import type { ShellIsland } from './island.js';
import { Sidebar, type SidebarLayout, type SidebarSlots } from './sidebar.js';
import { Stage } from './stage.js';

export type { SidebarSlots } from './sidebar.js';

export type ShellAppProps = {
  readonly island: ShellIsland;
  readonly slots?: SidebarSlots;
  /** False for the server render and the first client render, true after. */
  readonly hydrated: boolean;
  /** The layout in force, for the toggle's pressed state. The server render
   * and the first client render use `framed`; both layouts' chrome is always
   * in the markup and the host's `data-layout` decides which one is seen. */
  readonly layout?: SidebarLayout;
  /** Called by the Full width toggle. */
  readonly onToggleLayout?: () => void;
  /** The frame holds the render-failure page: the stage shows its panel. */
  readonly frameFailed?: boolean;
  /** Called by the failure panel's Reload page button. */
  readonly onReload?: () => void;
};

/**
 * The edit shell: the sidebar and the stage that holds the framed site. It is
 * rendered to markup on the server and hydrated on the client from the same
 * island, so the first client render matches the server's.
 */
export function ShellApp(props: ShellAppProps): ReactElement {
  const {
    island,
    slots,
    hydrated,
    layout = 'framed',
    onToggleLayout,
    frameFailed,
    onReload,
  } = props;
  return (
    <>
      <Sidebar
        island={island}
        slots={slots}
        hydrated={hydrated}
        layout={layout}
        onToggleLayout={onToggleLayout}
      />
      <Stage
        frameUrl={island.frameUrl}
        frameFailed={frameFailed}
        onReload={onReload}
      />
    </>
  );
}
