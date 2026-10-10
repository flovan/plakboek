import type { ReactElement } from 'react';
import type { ShellIsland } from './island.js';
import { Sidebar, type SidebarSlots } from './sidebar.js';
import { Stage } from './stage.js';

export type { SidebarSlots } from './sidebar.js';

export type ShellAppProps = {
  readonly island: ShellIsland;
  readonly slots?: SidebarSlots;
  /** False for the server render and the first client render, true after. */
  readonly hydrated: boolean;
};

/**
 * The edit shell: the sidebar and the stage that holds the framed site. It is
 * rendered to markup on the server and hydrated on the client from the same
 * island, so the first client render matches the server's.
 */
export function ShellApp(props: ShellAppProps): ReactElement {
  const { island, slots, hydrated } = props;
  return (
    <>
      <Sidebar
        island={island}
        slots={slots}
        hydrated={hydrated}
        layout="framed"
      />
      <Stage frameUrl={island.frameUrl} />
    </>
  );
}
