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
import { createUndoStack, type UndoEntry, type UndoStack } from './inverse.js';
import { createQueue, type QueueState } from './save-queue.js';
import { NO_SELECTION, type Selection } from './scope.js';
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
  /** The item a structural write just landed on; the overlay flashes it once per token. */
  readonly flash: { readonly id: string; readonly token: number } | null;
  /** Enter on a leaf asks for its Properties; the panel answers it (plan 08-24). */
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
  /** A delete waiting for the editor's confirmation, and what opened it. */
  readonly deleteRequest: {
    readonly id: string;
    readonly opener: 'toolbar' | 'region';
  } | null;
};

/** What a successful write changes in one step, so no one reads a half-applied state. */
export type WriteApplied = {
  readonly model: TreeModel;
  readonly pageVersion: number;
  readonly queue: QueueState;
  readonly selection: Selection;
};

export type EditorStore = {
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
  setQueue(queue: QueueState): void;
  setUndo(undo: UndoStack): void;
  /** A write succeeded: the tree, page version, queue and selection change together. */
  writeApplied(applied: WriteApplied): void;
  /** A newer tree read from the server, with no write of ours behind it. */
  treeRefreshed(tree: readonly ModelNode[], pageVersion: number): void;
  flash(id: string): void;
  clearFlash(): void;
  requestProperties(id: string): void;
  /** Shows the undo toast for a delete, replacing any earlier one. */
  showToast(entry: UndoEntry, label: string): void;
  clearToast(): void;
  /** Opens the delete confirmation for `id`. */
  askDelete(id: string, opener: 'toolbar' | 'region'): void;
  cancelDelete(): void;
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
    flash: null,
    propertiesRequest: null,
    toast: null,
    deleteRequest: null,
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
    undo: createUndoStack(),
    toast: null,
    deleteRequest: null,
  };
}

export function createEditorStore(
  initial: EditorState = initialEditorState(),
): EditorStore {
  let state = initial;
  const listeners = new Set<() => void>();
  let token = 0;

  function set(next: EditorState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  return {
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
      set({ ...state, status: 'unavailable', mode: 'interact' });
    },
    setMode(mode) {
      if (mode === state.mode) return;
      // Nothing is selected while the site is in the visitor's hands.
      set({
        ...state,
        mode,
        selection: mode === 'interact' ? NO_SELECTION : state.selection,
      });
    },
    select(selection) {
      if (state.mode !== 'edit') return;
      const same =
        selection.scopeId === state.selection.scopeId &&
        selection.selectedId === state.selection.selectedId;
      if (same) return;
      set({ ...state, selection });
    },
    announce(text) {
      if (text === state.announcement) return;
      set({ ...state, announcement: text });
    },
    setLock(view) {
      // Another editor holding the page ends this tab's editing.
      const taken = view.state === 'other' && state.status === 'editing';
      set({
        ...state,
        lock: view,
        ...(taken
          ? {
              status: 'locked',
              mode: 'interact',
              selection: NO_SELECTION,
              undo: createUndoStack(),
              toast: null,
              deleteRequest: null,
            }
          : {}),
      });
    },
    setQueue(queue) {
      set({ ...state, queue });
    },
    setUndo(undo) {
      set({ ...state, undo });
    },
    writeApplied(applied) {
      set({
        ...state,
        model: applied.model,
        pageVersion: applied.pageVersion,
        queue: applied.queue,
        selection: state.mode === 'edit' ? applied.selection : NO_SELECTION,
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
    requestProperties(id) {
      token += 1;
      set({ ...state, propertiesRequest: { id, token } });
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
