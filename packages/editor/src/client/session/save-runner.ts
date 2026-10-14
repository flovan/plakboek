/**
 * Turns an action into a saved write. `perform` queues an intent (a structural
 * one at once, a property edit after it has been idle), the runner sends the
 * queue's head as one request through a TanStack mutation scoped to the page's
 * write queue, and a success replaces the model, patches the frame in place and
 * keeps the acted item selected.
 *
 * The model and the frame change only on success, so a failed save leaves the
 * page as it was and the queue holds what could not be sent. A retry that meets
 * a stale version after a network failure may mean the first attempt was in
 * fact applied; the runner reads the tree again and either marks the save done
 * or pauses with the reason (EDIT-12).
 */
import {
  MutationObserver as QueryMutationObserver,
  type QueryClient,
} from '@tanstack/react-query';
import { formatString, STRINGS } from '../../chrome/strings.js';
import type {
  CatalogueEntry,
  EditNode,
  EditRequest,
  EditResponse,
  Fragment,
  FragmentPatch,
} from '../../api-types.js';
import {
  domViewOf,
  applyPatchSteps,
  INLINE_EDIT_END_EVENT,
} from '../frame/patch.js';
import { planPatch } from '../frame/patch-plan.js';
import type { HooksRuntime } from '../frame/hooks-runtime.js';
import {
  ApiRequestError,
  failureKindOf,
  type ApiClient,
} from './api-client.js';
import {
  closeTop,
  recordUndo,
  takeRedo,
  takeUndo,
  type ActionLabel,
  type UndoEntry,
} from './inverse.js';
import { WRITE_SCOPE_ID } from './query-client.js';
import {
  enqueueEntry,
  hasPending,
  markReady,
  onFailure,
  onSuccess,
  pruneEmpty,
  reconcileAfterStale,
  retry as retryQueue,
  takeNext,
  type Intent,
  type QueueEntry,
} from './save-queue.js';
import { NO_SELECTION, selectCrumb, type Selection } from './scope.js';
import type { EditorState, EditorStore } from './store.js';
import { createTreeModel, labelOf, type TreeModel } from './tree-model.js';

export type SaveRunnerOptions = {
  readonly store: EditorStore;
  readonly api: ApiClient;
  readonly queryClient: QueryClient;
  readonly frame: () => HTMLIFrameElement | null;
  /** Where the frame goes when a patch cannot be applied in place. */
  readonly frameUrl: string;
  readonly hooks: () => HooksRuntime | null;
  /** How long a property edit waits for more edits before it is sent. */
  readonly idleMs?: number;
};

/** What a caller can say about where the page goes once a write lands. */
export type PerformOptions = {
  /** The item to select afterwards; defaults to the item the intent acted on. */
  readonly selectId?: string | null;
  /** Whether the selected item flashes; true unless said otherwise. */
  readonly flash?: boolean;
};

export type SaveRunner = {
  /** Queues `intent`; `entry`, when given, is recorded for undo. */
  readonly perform: (
    intent: Intent,
    entry: UndoEntry | null,
    options?: PerformOptions,
  ) => void;
  /** Sends everything pending; true when all of it was saved. */
  readonly flush: () => Promise<boolean>;
  /**
   * Runs `run` once every write queued or in flight has been saved, at once
   * when nothing is. A structural action reads the model to say where an item
   * is, what it holds and what undoes the action, and the model only follows a
   * write when its answer arrives, so such an action must be built after the
   * writes before it. Actions held this way run in the order they were made;
   * when saving fails or pauses they are dropped, and the editor is told.
   */
  readonly whenSaved: (run: () => void) => void;
  /**
   * A property field lost focus: that block's pending edit (and whatever was
   * queued before it) is sent now instead of after the idle wait, and the
   * undo entry collecting its keystrokes is closed.
   */
  readonly ready: (blockId: string) => void;
  /** Sends the held write again after a failure. */
  readonly retry: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly dispose: () => void;
};

const DEFAULT_IDLE_MS = 1000;

type SendVariables = { readonly pageId: string; readonly request: EditRequest };

/** The item an intent acts on, which stays selected once the write lands. */
function actedId(intent: Intent): string | null {
  switch (intent.kind) {
    case 'insert':
      return intent.node.id ?? null;
    case 'duplicate':
      return intent.newId;
    case 'move':
    case 'update':
      return intent.blockId;
    case 'delete':
      return null;
    case 'group': {
      for (const member of intent.intents.toReversed()) {
        const id = actedId(member);
        if (id !== null) return id;
      }
      return null;
    }
  }
}

/** Whether the write creates an item the editor asked for: an insert, or a group that holds one (a new column). */
function addsItem(intent: Intent): boolean {
  if (intent.kind === 'group') return intent.intents.some(addsItem);
  return intent.kind === 'insert';
}

/** The type of an inserted node with this id, for naming an item that is not in the tree. */
function insertedType(intent: Intent, id: string): string | null {
  if (intent.kind === 'group') {
    for (const member of intent.intents) {
      const found = insertedType(member, id);
      if (found !== null) return found;
    }
    return null;
  }
  if (intent.kind !== 'insert') return null;
  const stack: EditNode[] = [intent.node];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.id === id) return node.type;
    stack.push(...(node.children ?? []));
  }
  return null;
}

/** Where the selection goes once the new tree is in: on the acted item when it exists. */
export function selectionAfterWrite(
  model: TreeModel,
  current: Selection,
  acted: string | null,
): Selection {
  if (acted !== null && model.get(acted) !== undefined) {
    return selectCrumb(model, acted);
  }
  if (current.selectedId !== null) {
    if (model.get(current.selectedId) !== undefined) {
      return selectCrumb(model, current.selectedId);
    }
    // The selected item is gone: the container it was in stays selected.
    return current.scopeId !== null && model.get(current.scopeId) !== undefined
      ? selectCrumb(model, current.scopeId)
      : NO_SELECTION;
  }
  if (current.scopeId !== null && model.get(current.scopeId) === undefined) {
    return NO_SELECTION;
  }
  return current;
}

function catalogueOf(state: EditorState): ReadonlyMap<string, CatalogueEntry> {
  return new Map(
    (state.session?.catalogue ?? []).map((item) => [item.key, item]),
  );
}

type EntryMeta = {
  readonly selectId: string | null;
  readonly flash: boolean;
  readonly announceMove: boolean;
  /** The write brings back a deleted item: say so once it is there. */
  readonly announceRestored: boolean;
  /** The write adds a new item: say so once it is there. */
  readonly announceAdded: boolean;
  readonly undoEntry: UndoEntry | null;
};

type EnqueueExtra = PerformOptions & {
  readonly fromHistory?: boolean;
  readonly restored?: boolean;
};

export function createSaveRunner(options: SaveRunnerOptions): SaveRunner {
  const { store, api, queryClient, frame, frameUrl, hooks } = options;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  let running = false;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** An attempt of the write in flight got no answer, so it may have been applied. */
  let uncertain = false;
  /** Rendered work held back for blocks under inline edit. */
  let deferred: ReadonlyMap<string, Fragment> = new Map();
  let listeningTo: Document | null = null;
  const meta = new Map<number, EntryMeta>();
  let waiters: ((saved: boolean) => void)[] = [];
  /** Actions waiting for the queue to empty, and the chain that runs them in order. */
  let held = 0;
  let heldChain: Promise<void> = Promise.resolve();

  const mutation = new QueryMutationObserver<
    EditResponse,
    Error,
    SendVariables
  >(queryClient, {
    scope: { id: WRITE_SCOPE_ID },
    mutationFn: async ({ pageId, request }) => {
      try {
        return await api.edit(pageId, request);
      } catch (error) {
        if (failureKindOf(error) === 'network') uncertain = true;
        throw error;
      }
    },
  });

  function reloadFrame(): void {
    deferred = new Map();
    frame()?.contentWindow?.location.replace(frameUrl);
  }

  function applyPatch(patch: FragmentPatch): void {
    const doc = frame()?.contentDocument ?? null;
    if (doc === null) return;
    if (listeningTo !== doc) {
      listeningTo?.removeEventListener(INLINE_EDIT_END_EVENT, release);
      doc.addEventListener(INLINE_EDIT_END_EVENT, release);
      listeningTo = doc;
    }
    const plan = planPatch(patch, domViewOf(doc), deferred);
    deferred = plan.deferred;
    const result = applyPatchSteps(doc, plan.steps);
    if (result.reloadNeeded) {
      reloadFrame();
      return;
    }
    if (result.replaced.length > 0) hooks()?.rendered(result.replaced);
  }

  /** An inline edit ended: work held back for it can go in now. */
  function release(): void {
    if (deferred.size === 0) return;
    applyPatch({ fragments: [], removed: [], rootOrder: null });
  }

  function settle(): void {
    if (waiters.length === 0) return;
    const queue = store.getState().queue;
    const saved =
      !hasPending(queue) &&
      queue.status !== 'failed' &&
      queue.status !== 'paused';
    const waiting = waiters;
    waiters = [];
    for (const resolve of waiting) resolve(saved);
  }

  function succeeded(entry: QueueEntry, response: EditResponse): void {
    uncertain = false;
    const state = store.getState();
    const info = meta.get(entry.seq);
    meta.delete(entry.seq);
    const model = createTreeModel(response.tree);
    store.writeApplied({
      model,
      pageVersion: response.pageVersion,
      queue: onSuccess(state.queue),
      selection: selectionAfterWrite(
        model,
        state.selection,
        info?.selectId ?? null,
      ),
    });
    if (response.patch !== null) applyPatch(response.patch);

    const acted = info?.selectId ?? null;
    if (acted === null || model.get(acted) === undefined) return;
    if (info?.flash === true) store.flash(acted);
    const after = store.getState();
    const text = (id: string): string => {
      const label = labelOf(model, catalogueOf(after), id);
      return label.kind === 'column'
        ? formatString('label.column', { n: String(label.n) })
        : label.text;
    };
    if (info?.announceRestored === true) {
      store.announce(formatString('announce.restored', { label: text(acted) }));
    } else if (info?.announceAdded === true) {
      // A new item that still lacks a required value says so, and the panel is asked for.
      const needsInput = (model.get(acted)?.needsInput.length ?? 0) > 0;
      store.announce(
        `${formatString('announce.added', { label: text(acted) })}${
          needsInput ? STRINGS['announce.needsInput'] : ''
        }`,
      );
      if (needsInput) store.requestProperties(acted);
    } else if (info?.announceMove === true) {
      const place = model.siblingIndex(acted);
      const parent = model.parentOf(acted);
      store.announce(
        formatString('announce.moved', {
          label: text(acted),
          position: String((place?.index ?? 0) + 1),
          total: String(place?.total ?? 1),
          parent: parent === null ? STRINGS['label.page'] : text(parent.id),
        }),
      );
    }
  }

  /**
   * A write met a stale version. Which it is decides what the editor is told:
   * if someone else holds the page now, it was taken over (the same lock
   * answer a refused write gets), and if the lock is still ours the page
   * changed in another tab or window.
   */
  async function noteStale(pageId: string): Promise<void> {
    try {
      const { lock } = await api.lock(pageId);
      if (lock.state === 'other') {
        store.setLock(lock);
        return;
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        store.pauseFor('session-ended');
        return;
      }
    }
    store.pauseFor('stale');
  }

  /** What to do with a failed write; true when the runner may go on. */
  async function failed(
    pageId: string,
    entry: QueueEntry,
    error: unknown,
  ): Promise<boolean> {
    const kind = failureKindOf(error);
    const state = store.getState();

    if (kind === 'stale' && uncertain) {
      try {
        const fresh = await api.tree(pageId);
        const freshModel = createTreeModel(fresh.tree);
        if (reconcileAfterStale(entry, freshModel) === 'already-applied') {
          uncertain = false;
          const info = meta.get(entry.seq);
          meta.delete(entry.seq);
          const current = store.getState();
          store.writeApplied({
            model: freshModel,
            pageVersion: fresh.pageVersion,
            queue: onSuccess(current.queue),
            selection: selectionAfterWrite(
              freshModel,
              current.selection,
              info?.selectId ?? null,
            ),
          });
          // The write landed but its answer never came, so there is no patch.
          reloadFrame();
          return true;
        }
        uncertain = false;
        store.setQueue(onFailure(store.getState().queue, 'stale'));
        await noteStale(pageId);
        return false;
      } catch {
        store.setQueue(onFailure(store.getState().queue, 'network'));
        return false;
      }
    }

    store.setQueue(onFailure(state.queue, kind));

    if (kind === 'refused') {
      uncertain = false;
      const info = meta.get(entry.seq);
      meta.delete(entry.seq);
      // The write will never happen, so it is not something to undo.
      const stack = store.getState().undo;
      if (info?.undoEntry != null && stack.undo.at(-1) === info.undoEntry) {
        store.setUndo({ undo: stack.undo.slice(0, -1), redo: stack.redo });
      }
      return true;
    }
    if (kind === 'locked' && error instanceof ApiRequestError) {
      // Someone else holds the page: this tab is read-only from here on.
      if (error.lock !== undefined) {
        store.setLock(error.lock);
      } else {
        try {
          store.setLock((await api.lock(pageId)).lock);
        } catch {
          // The lock could not be read; the pause stands.
        }
      }
    }
    if (kind === 'stale') await noteStale(pageId);
    if (kind === 'session') store.pauseFor('session-ended');
    if (kind !== 'network') uncertain = false;
    return false;
  }

  async function drain(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      for (;;) {
        const state = store.getState();
        const { model, session } = state;
        if (state.status !== 'editing' || model === null || session === null) {
          break;
        }
        const pruned = pruneEmpty(state.queue, model);
        if (pruned !== state.queue) store.setQueue(pruned);
        const taken = takeNext(pruned, model, state.pageVersion);
        if (taken === null) break;
        store.setQueue(taken.state);
        let goOn: boolean;
        try {
          const response = await mutation.mutate({
            pageId: session.pageId,
            request: taken.request,
          });
          if (disposed) break;
          succeeded(taken.entry, response);
          goOn = true;
        } catch (error) {
          if (disposed) break;
          goOn = await failed(session.pageId, taken.entry, error);
        }
        if (!goOn) break;
      }
    } finally {
      running = false;
      settle();
    }
  }

  function kick(): void {
    void drain();
  }

  function scheduleIdle(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      store.setQueue(markReady(store.getState().queue));
      // The burst of keystrokes ends when its save is sent.
      store.setUndo(closeTop(store.getState().undo));
      kick();
    }, idleMs);
  }

  function readyBlock(blockId: string): void {
    const state = store.getState();
    if (state.status !== 'editing') return;
    store.setQueue(markReady(state.queue, blockId));
    store.setUndo(closeTop(store.getState().undo));
    // Edits queued after this block's still wait for their own idle time.
    const waiting = store
      .getState()
      .queue.entries.some((entry) => !entry.ready);
    if (!waiting && idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    kick();
  }

  function enqueueIntent(
    intent: Intent,
    undoEntry: UndoEntry | null,
    extra: EnqueueExtra,
  ): void {
    const state = store.getState();
    if (state.status !== 'editing') return;
    // An undo or redo of a property change is a write of its own, sent at once
    // with the block's fresh markup, unlike the edits the editor is typing.
    const immediate = intent.kind !== 'update' || extra.fromHistory === true;
    const { state: queue, seq } = enqueueEntry(state.queue, intent, {
      immediate,
      fragments: immediate,
    });
    store.setQueue(queue);
    // `seq` is the entry that carries the intent, which an undo or redo of a
    // property change may have merged into an older one.
    if (immediate) {
      meta.set(seq, {
        selectId:
          extra.selectId === undefined ? actedId(intent) : extra.selectId,
        flash: extra.flash ?? intent.kind !== 'update',
        announceMove: intent.kind === 'move' && extra.fromHistory !== true,
        announceRestored: extra.restored === true,
        announceAdded: addsItem(intent) && extra.fromHistory !== true,
        undoEntry,
      });
    }
    if (undoEntry !== null) {
      store.setUndo(recordUndo(store.getState().undo, undoEntry));
    }
    if (immediate) kick();
    else scheduleIdle();
  }

  function actionText(entry: UndoEntry): string {
    const state = store.getState();
    const byKey = new Map(
      (state.session?.catalogue ?? []).map((item) => [item.key, item]),
    );
    const { action }: { action: ActionLabel } = entry;
    const model = state.model;
    let label = action.itemId;
    if (model?.get(action.itemId) !== undefined) {
      const named = labelOf(model, byKey, action.itemId);
      label =
        named.kind === 'column'
          ? formatString('label.column', { n: String(named.n) })
          : named.text;
    } else {
      const type =
        insertedType(entry.inverse, action.itemId) ??
        insertedType(entry.forward, action.itemId);
      if (type !== null) label = byKey.get(type)?.editor.label ?? type;
    }
    switch (action.kind) {
      case 'added':
        return formatString('action.added', { label });
      case 'moved':
        return formatString('action.moved', { label });
      case 'deleted':
        return formatString('action.deleted', { label });
      case 'duplicated':
        return formatString('action.duplicated', { label });
      case 'changed':
        return formatString('action.changed', {
          property: action.property ?? '',
          label,
        });
    }
  }

  function history(which: 'undo' | 'redo'): void {
    const state = store.getState();
    if (state.status !== 'editing' || state.model === null) return;
    const taken =
      which === 'undo' ? takeUndo(state.undo) : takeRedo(state.undo);
    if (taken === null) return;
    if (taken.entry.requiresDelete && state.session?.canDelete !== true) {
      // Skipped: this role may not delete, so the entry cannot be applied.
      store.setUndo(
        which === 'undo'
          ? { undo: taken.stack.undo, redo: state.undo.redo }
          : { undo: state.undo.undo, redo: taken.stack.redo },
      );
      store.announce(STRINGS['toolbar.reason.noDeletePermission']);
      return;
    }
    const text = actionText(taken.entry);
    store.setUndo(taken.stack);
    // Bringing a deleted item back is announced as such once it is there.
    const restores = which === 'undo' && taken.entry.action.kind === 'deleted';
    if (!restores) {
      store.announce(
        formatString(which === 'undo' ? 'announce.undone' : 'announce.redone', {
          action: text,
        }),
      );
    }
    enqueueIntent(taken.intent, null, {
      fromHistory: true,
      restored: restores,
    });
  }

  function flush(): Promise<boolean> {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    store.setQueue(markReady(store.getState().queue));
    return new Promise<boolean>((resolve) => {
      waiters.push(resolve);
      kick();
      if (!running) settle();
    });
  }

  async function runWhenSaved(run: () => void): Promise<void> {
    try {
      if (disposed) return;
      if (await flush()) {
        if (!disposed) run();
        return;
      }
      if (disposed) return;
      store.announce(
        STRINGS[
          store.getState().queue.status === 'paused'
            ? 'save.paused'
            : 'save.failed'
        ],
      );
    } finally {
      held -= 1;
    }
  }

  return {
    perform: (intent, entry, options = {}) => {
      enqueueIntent(intent, entry, options);
    },
    ready: readyBlock,
    flush,
    whenSaved: (run) => {
      if (held === 0 && !hasPending(store.getState().queue)) {
        run();
        return;
      }
      held += 1;
      const next = heldChain.then(async () => {
        await runWhenSaved(run);
      });
      // A failing action is reported, and must not stop the ones queued behind it.
      heldChain = next.catch((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    },
    retry: () => {
      store.setQueue(retryQueue(store.getState().queue));
      kick();
    },
    undo: () => {
      history('undo');
    },
    redo: () => {
      history('redo');
    },
    dispose: () => {
      disposed = true;
      if (idleTimer !== null) clearTimeout(idleTimer);
      listeningTo?.removeEventListener(INLINE_EDIT_END_EVENT, release);
      listeningTo = null;
      settle();
    },
  };
}
