/**
 * The editor's session state: one small framework-free store the shell, the
 * overlay and the chrome all read, so they agree on what is selected, which
 * mode the page is in and whether this tab may write.
 *
 * Every change is a pure transition of the previous state, made through a
 * named action. React reads it with `useEditorStore`, which subscribes through
 * `useSyncExternalStore`, so a component re-renders only when the slice it
 * selected changed.
 */
import { useSyncExternalStore } from 'react';
import type { EditorSession, LockView, ModelNode } from '../../api-types.js';
import { createDragFeed, type DragFeed } from '../drag/feed.js';
import type { DragSubject } from '../drag/slots.js';
import { createUndoStack, type UndoEntry, type UndoStack } from './inverse.js';
import type { InsertSlot } from './insertion.js';
import { createQueue, type QueueState } from './save-queue.js';
import type { RenewState } from './lock-client.js';
import { NO_SELECTION, sameSelection, type Selection } from './scope.js';
import { createTreeModel, type TreeModel } from './tree-model.js';

/** Edit selects and changes the page; Interact hands the page back to the site. */
export type EditorMode = 'edit' | 'interact';

/**
 * - `opening`: the open request is in flight.
 * - `editing`: this tab holds the page and may change it.
 * - `locked`: another editor holds the page.
 * - `unavailable`: the page could not be opened for editing.
 */
export type EditorStatus = 'opening' | 'editing' | 'locked' | 'unavailable';

/**
 * What opened the rail's panel drawer: the Blocks or Properties button, or the
 * notice button of a page that has no tools. Focus goes back to that button
 * when the drawer closes.
 */
export type DrawerOpener = 'blocks' | 'properties' | 'notice';

/** What opened the picker: focus returns to it when the picker closes with nothing added. */
export type PickerOpener =
  | 'insert-point'
  | 'toolbar'
  | 'empty-column'
  | 'empty-page'
  | 'key';

/** What asked for a delete: focus returns to it when the confirmation closes with nothing deleted. */
export type DeleteOpener = 'toolbar' | 'region' | 'panel';

/**
 * What the notice slot at the top of the sidebar says about the page:
 * another editor holds it, it just came free, it was taken over, it changed
 * in another tab, or the session ended.
 */
export type Notice = {
  readonly kind: 'locked' | 'lapsed' | 'taken-over' | 'stale' | 'session-ended';
  readonly holderName?: string;
  readonly lastActiveAt?: string;
};

/**
 * The drag in progress. A pointer drag is `active` once the pointer has moved
 * 4px, and only then covers the frame with the capture surface; a keyboard
 * drag is active from the lift. The pointer and the line change per frame and
 * live in the store's `dragFeed` instead.
 */
export type DragState = {
  readonly via: 'pointer' | 'keyboard';
  readonly subject: DragSubject;
  /** What the label that follows the pointer says. */
  readonly label: string;
  readonly active: boolean;
};

export type EditorState = {
  readonly status: EditorStatus;
  readonly session: EditorSession | null;
  readonly model: TreeModel | null;
  readonly pageVersion: number;
  readonly mode: EditorMode;
  readonly selection: Selection;
  readonly queue: QueueState;
  /** The editor's own actions this session, for undo and redo; cleared on reload. */
  readonly undo: UndoStack;
  /** The latest message for the live region. */
  readonly announcement: string;
  readonly lock: LockView | null;
  /** The banner about the page's state, if there is one. */
  readonly notice: Notice | null;
  /** Whether this tab's lock renewals are failing, and when one last worked. */
  readonly renewal: RenewState | null;
  /** The item a structural write just landed on; the overlay flashes it once per token. */
  readonly flash: { readonly id: string; readonly token: number } | null;
  /**
   * Whether the Properties sheet is open over the sidebar or the drawer. Only
   * an explicit ask opens it; while open it follows the selection.
   */
  readonly propertiesOpen: boolean;
  /** The rail's panel drawer: what opened it, or null while it is closed. */
  readonly drawer: DrawerOpener | null;
  /** The notice that was showing when the drawer was last open or closed, so a newer one is unread. */
  readonly noticeSeen: Notice | null;
  /**
   * An explicit ask for an item's Properties (a double-click or Enter on a
   * leaf, the toolbar button, an insert that needs input). It switches the
   * panel to Properties; the panel answers it by moving focus to a control.
   */
  readonly propertiesRequest: {
    readonly id: string;
    readonly token: number;
  } | null;
  /** The undo toast of the latest delete; shown while its entry is the next undo. */
  readonly toast: {
    readonly entry: UndoEntry;
    readonly label: string;
    readonly token: number;
  } | null;
  /** The open picker: the gap it adds to and what opened it, so focus can go back. */
  readonly picker: {
    readonly slot: InsertSlot;
    readonly opener: PickerOpener;
    readonly token: number;
  } | null;
  /** The drag in progress, or null. */
  readonly drag: DragState | null;
  /** A delete waiting for the editor's confirmation, and what opened it. */
  readonly deleteRequest: {
    readonly id: string;
    readonly opener: DeleteOpener;
  } | null;
  /** Leaving while a save failed: the editor is asked whether to stay. */
  readonly leaveRequest: { readonly token: number } | null;
};

/** What a successful write changes in one step, so no one reads a half-applied state. */
export type WriteApplied = {
  readonly model: TreeModel;
  readonly pageVersion: number;
  readonly queue: QueueState;
  readonly selection: Selection;
};

export type EditorStore = {
  /** What the overlay draws while an item is dragged: the pointer and the insertion line. */
  readonly dragFeed: DragFeed;
  getState(): EditorState;
  subscribe(listener: () => void): () => void;
  /** The open request answered: the session starts, or waits for the lock. */
  opened(session: EditorSession): void;
  /** The open request failed; the page stays a plain site. */
  failedToOpen(code: string | null): void;
  setMode(mode: EditorMode): void;
  /** Ignored unless the page is in Edit mode. */
  select(selection: Selection): void;
  announce(text: string): void;
  /** A newer lock view; one held by another editor ends editing in this tab. */
  setLock(view: LockView): void;
  /** Shows a banner about the page's state, or none. */
  setNotice(notice: Notice | null): void;
  /** Lock renewals started or stopped failing. */
  setRenewal(renewal: RenewState | null): void;
  /** The editor lost the page to someone else: read-only, nothing pending, banner. */
  tookOver(view: LockView): void;
  /** Saving cannot go on until the page is reloaded: the banner says why. */
  pauseFor(kind: 'stale' | 'session-ended'): void;
  /** Opens the "Leave without saving?" confirmation. */
  askLeave(): void;
  cancelLeave(): void;
  setQueue(queue: QueueState): void;
  setUndo(undo: UndoStack): void;
  /** A write succeeded: the tree, page version, queue and selection change together. */
  writeApplied(applied: WriteApplied): void;
  /** A newer tree read from the server, with no write of ours behind it. */
  treeRefreshed(tree: readonly ModelNode[], pageVersion: number): void;
  flash(id: string): void;
  clearFlash(): void;
  /** Opens the rail's drawer; the Properties button also opens the sheet. */
  openDrawer(opener: DrawerOpener): void;
  /** Closes the drawer and, with it, the Properties sheet. */
  closeDrawer(): void;
  /** Opens the Properties sheet without asking it to take focus. */
  openProperties(): void;
  closeProperties(): void;
  /** Opens Properties for `id` and asks the sheet to focus its first control. */
  requestProperties(id: string): void;
  /** Shows the undo toast for a delete, replacing any earlier one. */
  showToast(entry: UndoEntry, label: string): void;
  clearToast(): void;
  /** Opens the delete confirmation for `id`. */
  askDelete(id: string, opener: DeleteOpener): void;
  cancelDelete(): void;
  /** Opens the picker for a gap, replacing any open one. */
  openPicker(slot: InsertSlot, opener: PickerOpener): void;
  closePicker(): void;
  /** A drag starts, becomes active or ends; the picker closes while one runs. */
  setDrag(drag: DragState | null): void;
};

export function initialEditorState(): EditorState {
  return {
    status: 'opening',
    session: null,
    model: null,
    pageVersion: 0,
    mode: 'edit',
    selection: NO_SELECTION,
    queue: createQueue(),
    undo: createUndoStack(),
    announcement: '',
    lock: null,
    notice: null,
    renewal: null,
    flash: null,
    propertiesOpen: false,
    drawer: null,
    noticeSeen: null,
    propertiesRequest: null,
    toast: null,
    picker: null,
    drag: null,
    deleteRequest: null,
    leaveRequest: null,
  };
}

/** The notice for a page another editor holds. */
function lockedNotice(view: LockView): Notice {
  return {
    kind: 'locked',
    holderName: view.holder?.name ?? '',
    ...(view.holder === null ? {} : { lastActiveAt: view.holder.lastActiveAt }),
  };
}

/** Where the open request can lead, as a pure function of the state. */
export function openedState(
  state: EditorState,
  session: EditorSession,
): EditorState {
  const locked = session.lock.state === 'other';
  return {
    ...state,
    status: locked ? 'locked' : 'editing',
    session,
    model: createTreeModel(session.tree),
    pageVersion: session.pageVersion,
    // A page someone else holds is shown as a visitor would see it.
    mode: locked ? 'interact' : 'edit',
    selection: NO_SELECTION,
    lock: session.lock,
    notice: locked ? lockedNotice(session.lock) : null,
    renewal: null,
    propertiesOpen: false,
    // A new session starts with nothing queued, whatever the last one left.
    queue: createQueue(),
    undo: createUndoStack(),
    toast: null,
    picker: null,
    drag: null,
    deleteRequest: null,
    leaveRequest: null,
  };
}

export function createEditorStore(
  initial: EditorState = initialEditorState(),
): EditorStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const dragFeed = createDragFeed();
  let token = 0;

  function set(next: EditorState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function tookOver(view: LockView): void {
    set({
      ...state,
      lock: view,
      status: 'locked',
      mode: 'interact',
      selection: NO_SELECTION,
      // Whatever was not saved is dropped: it must never land on the new holder's page.
      queue: createQueue(),
      undo: createUndoStack(),
      notice: {
        kind: 'taken-over',
        holderName: view.holder?.name ?? '',
      },
      renewal: null,
      propertiesOpen: false,
      toast: null,
      picker: null,
      drag: null,
      deleteRequest: null,
      leaveRequest: null,
    });
  }

  return {
    dragFeed,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    opened(session) {
      set(openedState(state, session));
    },
    failedToOpen() {
      set({
        ...state,
        status: 'unavailable',
        mode: 'interact',
        propertiesOpen: false,
      });
    },
    setMode(mode) {
      if (mode === state.mode) return;
      // Nothing is selected while the site is in the visitor's hands.
      set({
        ...state,
        mode,
        selection: mode === 'interact' ? NO_SELECTION : state.selection,
        propertiesOpen: mode === 'interact' ? false : state.propertiesOpen,
        picker: null,
      });
    },
    select(selection) {
      if (state.mode !== 'edit') return;
      if (sameSelection(selection, state.selection)) return;
      // What the picker would add to belongs to the selection it was opened from.
      set({ ...state, selection, picker: null });
    },
    announce(text) {
      if (text === state.announcement) return;
      set({ ...state, announcement: text });
    },
    setLock(view) {
      // Another editor holding the page ends this tab's editing.
      if (view.state === 'other' && state.status === 'editing') {
        tookOver(view);
        return;
      }
      // While locked out, the banner follows who holds the page and since when.
      const follows = view.state === 'other' && state.notice?.kind === 'locked';
      set({
        ...state,
        lock: view,
        ...(follows ? { notice: lockedNotice(view) } : {}),
      });
    },
    tookOver,
    pauseFor(kind) {
      set({ ...state, notice: { kind } });
    },
    setNotice(notice) {
      if (notice === state.notice) return;
      set({ ...state, notice });
    },
    setRenewal(renewal) {
      set({ ...state, renewal });
    },
    askLeave() {
      token += 1;
      set({ ...state, leaveRequest: { token } });
    },
    cancelLeave() {
      if (state.leaveRequest === null) return;
      set({ ...state, leaveRequest: null });
    },
    setQueue(queue) {
      set({ ...state, queue });
    },
    setUndo(undo) {
      set({ ...state, undo });
    },
    writeApplied(applied) {
      const selection =
        state.mode === 'edit' ? applied.selection : NO_SELECTION;
      set({
        ...state,
        model: applied.model,
        pageVersion: applied.pageVersion,
        queue: applied.queue,
        // A selection that did not change stays the same object, so what
        // follows the selection (hooks, overlay) does not run again per save.
        selection: sameSelection(selection, state.selection)
          ? state.selection
          : selection,
      });
    },
    treeRefreshed(tree, pageVersion) {
      set({ ...state, model: createTreeModel(tree), pageVersion });
    },
    flash(id) {
      token += 1;
      set({ ...state, flash: { id, token } });
    },
    clearFlash() {
      if (state.flash === null) return;
      set({ ...state, flash: null });
    },
    openDrawer(opener) {
      if (state.drawer === opener) return;
      set({
        ...state,
        drawer: opener,
        noticeSeen: state.notice,
        propertiesOpen:
          opener === 'notice' ? state.propertiesOpen : opener === 'properties',
      });
    },
    closeDrawer() {
      if (state.drawer === null) {
        // Nothing to close but a sheet the sidebar holds.
        if (state.propertiesOpen) set({ ...state, propertiesOpen: false });
        return;
      }
      set({
        ...state,
        drawer: null,
        noticeSeen: state.notice,
        propertiesOpen: false,
      });
    },
    openProperties() {
      if (state.propertiesOpen) return;
      set({ ...state, propertiesOpen: true });
    },
    closeProperties() {
      if (!state.propertiesOpen) return;
      set({ ...state, propertiesOpen: false });
    },
    requestProperties(id) {
      token += 1;
      set({
        ...state,
        propertiesOpen: true,
        propertiesRequest: { id, token },
      });
    },
    showToast(entry, label) {
      token += 1;
      set({ ...state, toast: { entry, label, token } });
    },
    clearToast() {
      if (state.toast === null) return;
      set({ ...state, toast: null });
    },
    askDelete(id, opener) {
      if (state.mode !== 'edit') return;
      set({ ...state, deleteRequest: { id, opener } });
    },
    cancelDelete() {
      if (state.deleteRequest === null) return;
      set({ ...state, deleteRequest: null });
    },
    openPicker(slot, opener) {
      if (state.mode !== 'edit' || state.status !== 'editing') return;
      token += 1;
      set({ ...state, picker: { slot, opener, token } });
    },
    closePicker() {
      if (state.picker === null) return;
      set({ ...state, picker: null });
    },
    setDrag(drag) {
      if (drag === null && state.drag === null) return;
      set({ ...state, drag, picker: drag === null ? state.picker : null });
    },
  };
}

/** Reads a slice of the store; the component re-renders when the slice changes. */
export function useEditorStore<T>(
  store: EditorStore,
  selector: (state: EditorState) => T,
): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/** Stands in for the store where a component works with or without one. */
export const NO_STORE: EditorStore = createEditorStore();
