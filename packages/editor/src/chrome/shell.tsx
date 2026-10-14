import type { ReactElement } from 'react';
import type { CatalogueEntry, EditPosition } from '../api-types.js';
import { OverlayLayer } from '../client/overlay/overlay-layer.js';
import type { InsertSlot } from '../client/session/insertion.js';
import type { MoveDirection } from '../client/session/move-targets.js';
import {
  NO_STORE,
  useEditorStore,
  type EditorMode,
  type EditorStore,
  type PickerOpener,
} from '../client/session/store.js';
import { DeleteDialog } from './editing/delete-dialog.js';
import { LeaveDialog } from './editing/leave-dialog.js';
import { LiveRegion } from './editing/live-region.js';
import { NoticeSlot } from './editing/notices.js';
import { SidePanel } from './editing/panel.js';
import type { PropertiesPanelProps } from './editing/properties/properties-panel.js';
import { UndoToast } from './editing/toast.js';
import { ToolGroup } from './editing/tool-group.js';
import type { ShellIsland } from './island.js';
import { Sidebar, type SidebarLayout, type SidebarSlots } from './sidebar.js';
import { Stage } from './stage.js';

export type { SidebarSlots } from './sidebar.js';

function noop(): void {
  // Nothing to call: the shell was given no handler for this action.
}

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
    /** Called by the Take over button of the lock notice; true when it worked. */
    readonly onTakeOver?: () => Promise<boolean>;
    /** Called by the lock row's Keep editing button; true when the lock was renewed. */
    readonly onKeepEditing?: () => Promise<boolean>;
    /** Where the session-ended notice's Sign in leads. */
    readonly signInHref?: string;
    /** Called by Exit edit mode and Log out before they leave the page. */
    readonly onLeave?: (proceed: () => void) => void | Promise<void>;
    /** Called by the leave confirmation's Stay and Leave anyway. */
    readonly onStay?: () => void;
    readonly onLeaveAnyway?: () => void;
    /** Called by the Undo and Redo buttons. */
    readonly onUndo?: () => void;
    readonly onRedo?: () => void;
    /** Called by the floating toolbar's move buttons. */
    readonly onMove?: (id: string, direction: MoveDirection) => void;
    /** Called by the floating toolbar's Duplicate and Delete buttons. */
    readonly onDuplicate?: (id: string) => void;
    readonly onDelete?: (id: string) => void;
    /** Called by the delete confirmation's destructive button. */
    readonly onConfirmDelete?: (id: string) => void;
    /** Called when the delete confirmation closes with nothing deleted. */
    readonly onCancelDelete?: () => void;
    /** Called by the undo toast's button. */
    readonly onToastUndo?: () => void;
    /** Called by an insert point, an empty prompt and the toolbar's Add after. */
    readonly onOpenPicker?: (slot: InsertSlot, opener: PickerOpener) => void;
    /** Called when the picker closes with Escape. */
    readonly onClosePicker?: () => void;
    /** Called when the picker closes because a press or focus went elsewhere. */
    readonly onDismissPicker?: () => void;
    /** Called when a type is chosen in the picker. */
    readonly onPick?: (entry: CatalogueEntry) => void;
    /** Called when a palette row is chosen. */
    readonly onInsert?: (entry: CatalogueEntry, position: EditPosition) => void;
    /** Called when a Properties control changes a value: render it and queue the save. */
    readonly onPropertiesChange?: PropertiesPanelProps['onPropertiesChange'];
    /** Called when a Properties control loses focus: save the block's edit now. */
    readonly onPropertiesBlur?: PropertiesPanelProps['onPropertiesBlur'];
    /** Called by the Layout and Placement groups: render the layout and queue its save. */
    readonly onLayoutChange?: PropertiesPanelProps['onLayoutChange'];
    /** Which way a section's columns run in the site, for the Columns group's arrows. */
    readonly columnAxis?: PropertiesPanelProps['columnAxis'];
    /** Called by the Columns group's Add column, move and Remove. */
    readonly onAddColumn?: PropertiesPanelProps['onAddColumn'];
    readonly onMoveColumn?: PropertiesPanelProps['onMoveColumn'];
    readonly onRemoveColumn?: PropertiesPanelProps['onRemoveColumn'];
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
  const editRegion = useEditorStore(
    editor?.store ?? NO_STORE,
    (state) => state.status === 'editing' && state.mode === 'edit',
  );
  const editing =
    editor === undefined || !hydrated
      ? undefined
      : {
          notice: (
            <NoticeSlot
              store={editor.store}
              onTakeOver={editor.onTakeOver ?? (() => Promise.resolve(false))}
              onReload={onReload ?? noop}
              signInHref={editor.signInHref ?? '/cms'}
            />
          ),
          tools: (
            <ToolGroup
              store={editor.store}
              onMode={editor.onMode}
              onRetry={editor.onRetry}
              onUndo={editor.onUndo}
              onRedo={editor.onRedo}
              onKeepEditing={editor.onKeepEditing}
            />
          ),
          panel: (
            <SidePanel
              store={editor.store}
              onInsert={editor.onInsert ?? noop}
              onPropertiesChange={editor.onPropertiesChange}
              onPropertiesBlur={editor.onPropertiesBlur}
              onLayoutChange={editor.onLayoutChange}
              columnAxis={editor.columnAxis}
              onAddColumn={editor.onAddColumn}
              onMoveColumn={editor.onMoveColumn}
              onRemoveColumn={editor.onRemoveColumn}
            />
          ),
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
        onLeave={editor?.onLeave}
      />
      <Stage
        frameUrl={island.frameUrl}
        editRegion={hydrated && editor !== undefined && editRegion}
        frameFailed={frameFailed}
        onReload={onReload}
        toast={
          hydrated && editor !== undefined ? (
            <UndoToast
              store={editor.store}
              onUndo={editor.onToastUndo ?? editor.onUndo ?? noop}
            />
          ) : null
        }
      />
      {hydrated && island.mode === 'edit' ? (
        <OverlayLayer
          store={editor?.store}
          onMove={editor?.onMove}
          onDuplicate={editor?.onDuplicate}
          onDelete={editor?.onDelete}
          onOpenPicker={editor?.onOpenPicker}
          onClosePicker={editor?.onClosePicker}
          onDismissPicker={editor?.onDismissPicker}
          onPick={editor?.onPick}
        />
      ) : null}
      {hydrated && editor !== undefined ? (
        <>
          <LiveRegion store={editor.store} />
          <LeaveDialog
            store={editor.store}
            onStay={editor.onStay ?? noop}
            onLeave={editor.onLeaveAnyway ?? noop}
          />
          <DeleteDialog
            store={editor.store}
            onConfirm={editor.onConfirmDelete ?? noop}
            onCancel={editor.onCancelDelete ?? noop}
          />
        </>
      ) : null}
    </>
  );
}
