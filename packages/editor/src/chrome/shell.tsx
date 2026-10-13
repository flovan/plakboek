import type { ReactElement } from 'react';
import { OverlayLayer } from '../client/overlay/overlay-layer.js';
import type { EditorMode, EditorStore } from '../client/session/store.js';
import { LiveRegion } from './editing/live-region.js';
import { ToolGroup } from './editing/tool-group.js';
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
  /** The editing session, for a user who can edit once the client runs. */
  readonly editor?: {
    readonly store: EditorStore;
    /** Called by the mode toggle. */
    readonly onMode: (mode: EditorMode) => void;
    /** Called by the save status's Retry button. */
    readonly onRetry?: () => void;
  };
};

/**
 * The edit shell: the sidebar and the stage that holds the framed site. It is
 * rendered to markup on the server and hydrated on the client from the same
 * island, so the first client render matches the server's. The hover overlay
 * is mounted only for a user who can edit, and only once the client has
 * hydrated: it reads the frame, which the server cannot.
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
    editor,
  } = props;
  const editing =
    editor === undefined || !hydrated
      ? undefined
      : {
          notice: null,
          tools: (
            <ToolGroup
              store={editor.store}
              onMode={editor.onMode}
              onRetry={editor.onRetry}
            />
          ),
          panel: null,
        };
  return (
    <>
      <Sidebar
        island={island}
        slots={slots}
        editing={editing}
        hydrated={hydrated}
        layout={layout}
        onToggleLayout={onToggleLayout}
      />
      <Stage
        frameUrl={island.frameUrl}
        frameFailed={frameFailed}
        onReload={onReload}
      />
      {hydrated && island.mode === 'edit' ? (
        <OverlayLayer store={editor?.store} />
      ) : null}
      {hydrated && editor !== undefined ? (
        <LiveRegion store={editor.store} />
      ) : null}
    </>
  );
}
