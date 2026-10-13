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
import type { EditorSession, LockView } from '../../api-types.js';
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
  /** The latest message for the live region. */
  readonly announcement: string;
  readonly lock: LockView | null;
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
    announcement: '',
    lock: null,
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
  };
}

export function createEditorStore(
  initial: EditorState = initialEditorState(),
): EditorStore {
  let state = initial;
  const listeners = new Set<() => void>();

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
          ? { status: 'locked', mode: 'interact', selection: NO_SELECTION }
          : {}),
      });
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
