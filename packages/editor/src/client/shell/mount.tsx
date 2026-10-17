import {
  QueryClientProvider,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { hydrateRoot as hydrate, type Root } from 'react-dom/client';
import type { SidebarLayout } from '../../chrome/controls.js';
import { ShellApp } from '../../chrome/shell.js';
import { SHELL_ROOT_ID, type ShellIsland } from '../../chrome/island.js';
import { STAGE_ID } from '../../chrome/stage.js';
import { formatString, STRINGS } from '../../chrome/strings.js';
import type { BlockEditHooks } from '@plakboek/render';
import type { BootEditorOptions } from '../boot.js';
import { attachClaim } from '../frame/claim.js';
import { loadBlockEditModules } from '../frame/block-edit-loader.js';
import { hitChain } from '../frame/hit-test.js';
import {
  createHooksRuntime,
  type HooksRuntime,
} from '../frame/hooks-runtime.js';
import { measureSiblingAxis } from '../frame/sibling-axis.js';
import type {
  CatalogueEntry,
  EditPosition,
  ModelLayout,
  PreviewResponse,
} from '../../api-types.js';
import { createApiClient } from '../session/api-client.js';
import { addColumnIntent, layoutIntent } from '../session/column-actions.js';
import { buildUndoEntry } from '../session/inverse.js';
import {
  insertActionFor,
  slotAfter,
  slotKey,
  slotPosition,
  soleSectionType,
  type InsertSlot,
} from '../session/insertion.js';
import {
  startLockClient,
  startLockWatch,
  type LockClientHandle,
} from '../session/lock-client.js';
import {
  legalityContextOf,
  moveActionFor,
  moveToPositionFor,
} from '../session/move-action.js';
import type { MoveDirection } from '../session/move-targets.js';
import { withValues } from '../session/property-drafts.js';
import {
  createPreviewRunner,
  type PreviewRunner,
} from '../session/preview-runner.js';
import { createEditorQueryClient } from '../session/query-client.js';
import { hasPending, type Intent } from '../session/save-queue.js';
import { createSaveRunner, type SaveRunner } from '../session/save-runner.js';
import {
  climb,
  drillByDoubleClick,
  drillFirst,
  firstSibling,
  lastSibling,
  nextSibling,
  previousSibling,
  sameSelection,
  selectByClick,
} from '../session/scope.js';
import { selectAndAnnounce } from '../session/selection-announcement.js';
import {
  deleteActionFor,
  deleteBlockedReason,
  duplicateActionFor,
  needsDeleteConfirmation,
} from '../session/structure-actions.js';
import {
  createEditorStore,
  useEditorStore,
  type DeleteOpener,
  type DrawerOpener,
  type EditorMode,
  type EditorState,
  type PickerOpener,
} from '../session/store.js';
import { createDragSession } from './drag-session.js';
import { drawerFits, setDrawerColumn } from './drawer.js';
import { watchFrame } from './frame-watch.js';
import { keyAction, structureKeyAction } from './keys.js';
import { applyLayout, readLayout, writeLayout } from './layout.js';

/**
 * Moves keyboard focus into the layer the layout switch just showed. Both
 * layers are always in the markup and the host attribute hides one, and
 * browsers drop focus from a control whose layer becomes hidden, which would
 * leave a keyboard user on the page body. Focus follows to the same toggle in
 * the layer now shown, but only when it was inside the layer being hidden: focus
 * that is elsewhere (after a WebKit mouse click, which does not focus a button)
 * stays where the browser put it. The call works synchronously because the
 * shown layer's state leaves `visibility` out of its transition (see the
 * rail's layer).
 */
function focusShownToggle(host: HTMLElement, shown: SidebarLayout): void {
  const root = host.shadowRoot;
  if (root === null) return;
  const hidden = root.querySelector(
    shown === 'full' ? '[data-sidebar]' : '[data-rail]',
  );
  const toggle = root.querySelector(
    shown === 'full'
      ? '[data-rail] [data-layout-toggle]'
      : '[data-sidebar] [data-layout-toggle]',
  );
  const active = root.activeElement;
  if (
    active !== null &&
    hidden?.contains(active) === true &&
    toggle instanceof HTMLElement
  ) {
    toggle.focus({ preventScroll: true });
  }
}

/** How long the "stopped editing" notice stays. */
const LAPSED_NOTICE_MS = 8000;

function frameOf(host: HTMLElement): HTMLIFrameElement | null {
  const frame = host.shadowRoot?.querySelector('iframe');
  return frame instanceof HTMLIFrameElement ? frame : null;
}

/** The path of a visitor location: the open request names a page, not a query. */
function pathOfLocation(location: string): string {
  const query = location.indexOf('?');
  return query === -1 ? location : location.slice(0, query);
}

/**
 * Takes focus out of the framed site, so a key press after switching back to
 * Edit is not typed into something the site left focused, and puts it on the
 * stage region.
 */
function focusStage(host: HTMLElement, frame: HTMLIFrameElement | null): void {
  const active = frame?.contentDocument?.activeElement ?? null;
  if (active !== null) {
    const blur: unknown = Reflect.get(active, 'blur');
    if (typeof blur === 'function') Reflect.apply(blur, active, []);
  }
  host.shadowRoot?.getElementById(STAGE_ID)?.focus({ preventScroll: true });
}

/** Keeps keyboard focus on the page region, never in the framed site. */
function focusRegion(host: HTMLElement): void {
  host.shadowRoot?.getElementById(STAGE_ID)?.focus({ preventScroll: true });
}

function Shell(props: {
  readonly host: HTMLElement;
  readonly island: ShellIsland;
  readonly options: BootEditorOptions;
}): ReactElement {
  const { host, island, options } = props;
  const editable = island.mode === 'edit';
  const [store] = useState(createEditorStore);
  const [api] = useState(() => createApiClient());
  const queryClient = useQueryClient();
  const hooksRef = useRef<HooksRuntime | null>(null);
  const runnerRef = useRef<SaveRunner | null>(null);
  const previewRef = useRef<PreviewRunner | null>(null);
  const status = useEditorStore(store, (state) => state.status);
  const session = useEditorStore(store, (state) => state.session);
  // The first client render must match the server markup, which was rendered
  // before hydration and always in the framed state, so `hydrated` and
  // `layout` change only after it.
  const [hydrated, setHydrated] = useState(false);
  const [layout, setLayout] = useState<SidebarLayout>('framed');
  const [frameFailed, setFrameFailed] = useState(false);
  useEffect(() => {
    // The pre-paint script already set the attribute from storage; applying
    // the stored value again covers a browser that blocked that script.
    const stored = readLayout();
    applyLayout(host, stored);
    setLayout(stored);
    setHydrated(true);
    host.dataset.hydrated = '';
  }, [host]);

  // The host's block edit modules load once, after hydration and in edit mode
  // only. The frame runtime below calls their hooks.
  const [blockHooks, setBlockHooks] = useState<
    ReadonlyMap<string, BlockEditHooks>
  >(() => new Map());
  const blockEdit = options.blockEdit;
  useEffect(() => {
    if (!hydrated || !editable || blockEdit === undefined) return undefined;
    let cancelled = false;
    void loadBlockEditModules(blockEdit).then((loaded) => {
      if (!cancelled) setBlockHooks(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, editable, blockEdit]);

  // A hooks runtime follows each document the frame loads: it enters edit mode
  // on its blocks, and runs `rendered` (then `enter`) on the blocks the
  // development block swap replaces, which it hears of from the frame
  // document. It reads each block's properties from the session and follows
  // the store's mode and selection.
  useEffect(() => {
    if (!hydrated || !editable || blockHooks.size === 0) return undefined;
    const frame = frameOf(host);
    if (frame === null) return undefined;
    const runtime = createHooksRuntime({
      hooks: blockHooks,
      propsOf: (id) => store.getState().model?.get(id)?.props,
      mode: store.getState().mode,
    });
    hooksRef.current = runtime;
    let attached: Document | null = null;
    const attach = (): void => {
      const frameDocument = frame.contentDocument;
      if (
        frameDocument === null ||
        frameDocument === attached ||
        frameDocument.URL === 'about:blank' ||
        frameDocument.readyState !== 'complete'
      ) {
        return;
      }
      attached = frameDocument;
      runtime.attach(frameDocument);
    };
    const selectIn = (state: EditorState): void => {
      const { model } = state;
      const { selectedId } = state.selection;
      runtime.select(
        selectedId,
        model === null || selectedId === null
          ? []
          : model
              .ancestorsOf(selectedId)
              .map((ancestor) => ancestor.id)
              .reverse(),
      );
    };
    // The modules may load after the editor selected something: the runtime
    // starts from the current selection and applies it once it is attached.
    selectIn(store.getState());
    frame.addEventListener('load', attach);
    attach();

    let previous = store.getState();
    const unsubscribe = store.subscribe(() => {
      const next = store.getState();
      if (next.mode !== previous.mode) runtime.setMode(next.mode);
      if (!sameSelection(next.selection, previous.selection)) selectIn(next);
      previous = next;
    });
    return () => {
      unsubscribe();
      frame.removeEventListener('load', attach);
      hooksRef.current = null;
      runtime.dispose();
    };
  }, [host, hydrated, editable, blockHooks, store]);

  // Another editor taking the page over drops what this tab had not saved, so
  // the frame must stop showing it: a property change rendered by the live
  // preview stays on screen after its write is refused. The heartbeat, a 423
  // refusal and a stale refusal after the takeover all end in this one store
  // transition, so the frame is put back to the working tree here. An answer
  // still in flight is cancelled first, so it cannot put the edit back.
  useEffect(() => {
    if (!hydrated || !editable) return undefined;
    let previous = store.getState();
    const unsubscribe = store.subscribe(() => {
      const next = store.getState();
      if (
        previous.status === 'editing' &&
        next.status === 'locked' &&
        next.notice?.kind === 'taken-over'
      ) {
        previewRef.current?.cancel();
        frameOf(host)?.contentWindow?.location.replace(island.frameUrl);
      }
      previous = next;
    });
    return unsubscribe;
  }, [host, hydrated, editable, store, island.frameUrl]);

  // The lock watch starts again after a failed re-open.
  const [watchRound, setWatchRound] = useState(0);
  // The editor took the page over, so the answer is not "the holder stopped".
  const tookOver = useRef(false);
  // The lock client's renew-now, while this tab holds the page.
  const lockRef = useRef<LockClientHandle | null>(null);

  // Opening the page for editing: one request after hydration, which takes
  // the lock and brings the page tree. A page that was stored before columns
  // existed comes back upgraded, so the frame is reloaded to show it.
  const open = useMutation({
    mutationFn: async () =>
      await api.open(pathOfLocation(island.visitorLocation)),
    onSuccess: (opened) => {
      const before = store.getState();
      const wasLocked = before.status === 'locked';
      const heldBy = before.notice?.holderName ?? '';
      store.opened(opened);
      const nowMine = opened.lock.state !== 'other';
      // A page that was held and is free now shows the working tree as the
      // last holder left it.
      if (opened.upgraded || (wasLocked && nowMine)) {
        frameOf(host)?.contentWindow?.location.replace(island.frameUrl);
      }
      if (wasLocked && nowMine && !tookOver.current) {
        store.setNotice({ kind: 'lapsed', holderName: heldBy });
        store.announce(formatString('notice.lapsed', { name: heldBy }));
      }
      tookOver.current = false;
    },
    onError: (error) => {
      // A page that was only waiting for its holder keeps waiting.
      if (store.getState().status === 'locked') {
        setWatchRound((round) => round + 1);
        return;
      }
      const code: unknown = Reflect.get(error, 'code');
      store.failedToOpen(typeof code === 'string' ? code : null);
    },
  });
  const runOpen = open.mutate;
  const openStarted = useRef(false);
  useEffect(() => {
    if (!hydrated || !editable || openStarted.current) return;
    openStarted.current = true;
    open.mutate();
  }, [hydrated, editable, open]);

  // Tests and tools read where the session stands from the host.
  useEffect(() => {
    if (editable) host.dataset.session = status;
  }, [host, editable, status]);

  // The save runner lives as long as this tab holds the page: it sends the
  // queue, patches the frame and keeps the undo stack's writes in order.
  useEffect(() => {
    if (!hydrated || !editable || status !== 'editing') return undefined;
    const runner = createSaveRunner({
      store,
      api,
      queryClient,
      frame: () => frameOf(host),
      frameUrl: island.frameUrl,
      hooks: () => hooksRef.current,
    });
    runnerRef.current = runner;
    // The live preview of a property change renders into the same frame.
    const preview = createPreviewRunner({
      api,
      pageId: store.getState().session?.pageId ?? '',
      frame: () => frameOf(host),
      hooks: () => hooksRef.current,
    });
    previewRef.current = preview;
    return () => {
      previewRef.current = null;
      preview.cancel();
      runnerRef.current = null;
      runner.dispose();
    };
  }, [
    host,
    hydrated,
    editable,
    status,
    store,
    api,
    queryClient,
    island.frameUrl,
  ]);

  // A property change is rendered before it is queued, so for a moment it is
  // neither pending nor saved. Leaving waits for these to settle.
  const propertyWork = useRef({
    busy: 0,
    waiters: [] as (() => void)[],
  });
  const trackPropertyWork = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      const tracker = propertyWork.current;
      tracker.busy += 1;
      try {
        return await work();
      } finally {
        tracker.busy -= 1;
        if (tracker.busy === 0) {
          const waiting = tracker.waiters;
          tracker.waiters = [];
          for (const resolve of waiting) resolve();
        }
      }
    },
    [],
  );
  const propertyWorkSettled = useCallback((): Promise<void> => {
    const tracker = propertyWork.current;
    if (tracker.busy === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      tracker.waiters.push(resolve);
    });
  }, []);

  /**
   * A Properties control changed: render the block with the candidate values
   * and, when the engine accepts them, queue the save as one edit that the
   * keystrokes of this field share (one undo step, sent after a pause or on
   * blur). A refusal queues nothing and leaves the frame on its last render.
   */
  const changeProperties = useCallback(
    async (
      blockId: string,
      values: Readonly<Record<string, unknown>>,
      changedKey: string,
      immediate: boolean,
    ): Promise<PreviewResponse | null> =>
      await trackPropertyWork(async () => {
        const state = store.getState();
        const node = state.model?.get(blockId);
        const preview = previewRef.current;
        if (
          state.status !== 'editing' ||
          node === undefined ||
          preview === null
        ) {
          return null;
        }
        const response = await preview.change(
          blockId,
          { props: withValues(node.props, values) },
          immediate,
        );
        if (response?.ok !== true) return response;
        const latest = store.getState();
        const { model, session } = latest;
        const runner = runnerRef.current;
        if (
          latest.status !== 'editing' ||
          model === null ||
          model.get(blockId) === undefined ||
          runner === null
        ) {
          return response;
        }
        const type = model.get(blockId)?.type;
        const property = session?.catalogue
          .find((entry) => entry.key === type)
          ?.properties.find((item) => item.key === changedKey);
        const intent: Intent = { kind: 'update', blockId, props: values };
        runner.perform(
          intent,
          buildUndoEntry(
            intent,
            model,
            {
              kind: 'changed',
              itemId: blockId,
              property: property?.label ?? changedKey,
            },
            { coalesceKey: `${blockId}:${changedKey}`, open: true },
          ),
        );
        return response;
      }),
    [store, trackPropertyWork],
  );

  const blurProperties = useCallback((blockId: string) => {
    runnerRef.current?.ready(blockId);
  }, []);

  /**
   * A layout choice (column widths, alignment, fill): render the item with it
   * and, when the engine accepts it, queue the save like a picked property
   * value. The choices of one burst share an undo entry. Resolves with whether
   * the layout was accepted.
   */
  const changeLayout = useCallback(
    async (
      blockId: string,
      layout: ModelLayout,
      property: string,
    ): Promise<boolean> =>
      await trackPropertyWork(async () => {
        const state = store.getState();
        const { model } = state;
        const preview = previewRef.current;
        if (
          state.status !== 'editing' ||
          model === null ||
          model.get(blockId) === undefined ||
          preview === null
        ) {
          return false;
        }
        const intent = layoutIntent(model, blockId, layout);
        if (intent.kind !== 'update') return false;
        const response = await preview.change(
          blockId,
          { layout: intent.layout ?? null },
          true,
        );
        if (response?.ok !== true) return false;
        const latest = store.getState();
        const runner = runnerRef.current;
        if (
          latest.status !== 'editing' ||
          latest.model === null ||
          latest.model.get(blockId) === undefined ||
          runner === null
        ) {
          return false;
        }
        runner.perform(
          intent,
          buildUndoEntry(
            intent,
            latest.model,
            { kind: 'changed', itemId: blockId, property },
            { coalesceKey: `${blockId}:layout`, open: true },
          ),
        );
        return true;
      }),
    [store, trackPropertyWork],
  );

  /** Adds a column to a section, after one of its columns or last; the new column is selected. */
  const addColumn = useCallback(
    (sectionId: string, afterColumnId: string | null) => {
      const state = store.getState();
      if (state.status !== 'editing' || state.mode !== 'edit') return;
      store.closePicker();
      // Built from the model once the writes before it are saved.
      runnerRef.current?.whenSaved(() => {
        const { model } = store.getState();
        if (model === null || model.get(sectionId)?.kind !== 'section') return;
        const newId = crypto.randomUUID();
        const intent = addColumnIntent(model, sectionId, afterColumnId, newId);
        runnerRef.current?.perform(
          intent,
          buildUndoEntry(intent, model, { kind: 'added', itemId: newId }),
          { selectId: newId },
        );
        // The control that asked (the panel's button) is replaced by the new column's panel.
        requestAnimationFrame(() => {
          focusRegion(host);
        });
      });
    },
    [host, store],
  );

  const addColumnLast = useCallback(
    (sectionId: string) => {
      addColumn(sectionId, null);
    },
    [addColumn],
  );

  /** Which way a section's columns run in the framed site. */
  const columnAxis = useCallback(
    (columnIds: readonly string[]): 'horizontal' | 'vertical' => {
      const frameDocument = frameOf(host)?.contentDocument ?? null;
      return frameDocument === null
        ? 'horizontal'
        : measureSiblingAxis(frameDocument, columnIds);
    },
    [host],
  );

  /** A column's move from its section's panel: the section stays selected, so more moves can follow. */
  const moveColumnFromPanel = useCallback(
    (id: string, direction: MoveDirection) => {
      runnerRef.current?.whenSaved(() => {
        const state = store.getState();
        const action = moveActionFor(state, id, direction);
        if (action === null) return;
        runnerRef.current?.perform(action.intent, action.entry, {
          selectId: state.selection.selectedId,
          flash: false,
        });
      });
    },
    [store],
  );

  const moveItem = useCallback(
    (id: string, direction: MoveDirection) => {
      runnerRef.current?.whenSaved(() => {
        const action = moveActionFor(store.getState(), id, direction);
        if (action !== null)
          runnerRef.current?.perform(action.intent, action.entry);
      });
    },
    [store],
  );

  /** Deletes at once and offers to undo it; the caller has settled any confirmation. */
  const performDelete = useCallback(
    (id: string, opener: DeleteOpener) => {
      const runner = runnerRef.current;
      if (runner === null) return;
      // The undo captures the item as saved, so it is built once the writes before it are.
      runner.whenSaved(() => {
        const state = store.getState();
        const action = deleteActionFor(state, id);
        if (action === null) return;
        // Removing a column from its section's panel leaves the section selected, so more can follow.
        const selectId =
          opener === 'panel'
            ? (state.model?.get(id)?.parentId ?? action.selectId)
            : action.selectId;
        runner.perform(action.intent, action.entry, { selectId, flash: false });
        store.showToast(action.entry, action.label);
        store.announce(formatString('action.deleted', { label: action.label }));
        // After the confirmation (if any) has closed and handed the page back.
        requestAnimationFrame(() => {
          focusRegion(host);
        });
      });
    },
    [host, store],
  );

  /** Delete from the toolbar or the keyboard: it asks first when blocks go with the item. */
  const deleteItem = useCallback(
    (id: string, opener: DeleteOpener) => {
      const state = store.getState();
      const { model } = state;
      if (state.status !== 'editing' || state.mode !== 'edit') return;
      if (model === null || model.get(id) === undefined) return;
      const blocked = deleteBlockedReason(state, id);
      if (blocked !== null) {
        store.announce(STRINGS[blocked]);
        return;
      }
      if (needsDeleteConfirmation(model, id)) store.askDelete(id, opener);
      else performDelete(id, opener);
    },
    [store, performDelete],
  );

  const confirmDelete = useCallback(
    (id: string) => {
      const opener = store.getState().deleteRequest?.opener ?? 'region';
      store.cancelDelete();
      performDelete(id, opener);
    },
    [store, performDelete],
  );

  /** The dialog closed with nothing deleted: focus goes back to what opened it. */
  const cancelDelete = useCallback(() => {
    const request = store.getState().deleteRequest;
    store.cancelDelete();
    if (request === null) return;
    requestAnimationFrame(() => {
      const button =
        request.opener === 'toolbar'
          ? host.shadowRoot?.querySelector('[data-roving="delete"]')
          : request.opener === 'panel'
            ? host.shadowRoot?.querySelector(
                `[data-column-remove="${request.id}"]`,
              )
            : null;
      if (button instanceof HTMLElement) button.focus({ preventScroll: true });
      else focusRegion(host);
    });
  }, [host, store]);

  const deleteFromToolbar = useCallback(
    (id: string) => {
      deleteItem(id, 'toolbar');
    },
    [deleteItem],
  );

  const removeFromPanel = useCallback(
    (id: string) => {
      deleteItem(id, 'panel');
    },
    [deleteItem],
  );

  const duplicateItem = useCallback(
    (id: string) => {
      const first = store.getState();
      if (first.status !== 'editing' || first.mode !== 'edit') return;
      runnerRef.current?.whenSaved(() => {
        const state = store.getState();
        if (state.status !== 'editing' || state.mode !== 'edit') return;
        const newId = crypto.randomUUID();
        const action = duplicateActionFor(state, id, newId);
        if (action === null) {
          store.announce(STRINGS['toolbar.reason.noDuplicate']);
          return;
        }
        // A copied column also resets its section's ratio, so the copy is named.
        runnerRef.current?.perform(action.intent, action.entry, {
          selectId: newId,
        });
      });
    },
    [store],
  );

  /** Adds a new item of a type at a position; the runner selects it once it is saved. */
  const insertEntry = useCallback(
    (entry: CatalogueEntry, position: EditPosition, moveFocus: boolean) => {
      const state = store.getState();
      if (state.status !== 'editing' || state.mode !== 'edit') return;
      if (state.model === null) return;
      store.closePicker();
      runnerRef.current?.whenSaved(() => {
        const { model } = store.getState();
        if (model === null) return;
        const action = insertActionFor(
          model,
          entry,
          position,
          crypto.randomUUID(),
        );
        runnerRef.current?.perform(action.intent, action.entry);
      });
      if (moveFocus) {
        requestAnimationFrame(() => {
          focusRegion(host);
        });
      }
    },
    [host, store],
  );

  /** A drop of a dragged item: saved at once, like a move by the buttons. */
  const moveTo = useCallback(
    (id: string, position: EditPosition) => {
      runnerRef.current?.whenSaved(() => {
        const action = moveToPositionFor(store.getState(), id, position);
        if (action !== null) {
          runnerRef.current?.perform(action.intent, action.entry);
        }
      });
    },
    [store],
  );

  /** Opens the picker for a gap; a section gap with only one legal type adds it at once. */
  const openPicker = useCallback(
    (slot: InsertSlot, opener: PickerOpener) => {
      const state = store.getState();
      const ctx = legalityContextOf(state);
      if (state.status !== 'editing' || state.mode !== 'edit' || ctx === null) {
        return;
      }
      // A column is the only thing a section holds: it is added with no picker.
      if (slot.level === 'column' && slot.parentId !== null) {
        addColumn(slot.parentId, slot.previousId);
        return;
      }
      const sole = soleSectionType(ctx, slot);
      if (sole !== null) {
        insertEntry(sole, slotPosition(slot), true);
        return;
      }
      store.openPicker(slot, opener);
    },
    [addColumn, insertEntry, store],
  );

  /** Escape: the picker closes and focus goes back to what opened it. */
  const closePicker = useCallback(() => {
    const picker = store.getState().picker;
    store.closePicker();
    if (picker === null) return;
    requestAnimationFrame(() => {
      const root = host.shadowRoot;
      const selector =
        picker.opener === 'insert-point'
          ? `[data-slot="${slotKey(picker.slot)}"]`
          : picker.opener === 'toolbar'
            ? '[data-roving="add"]'
            : picker.opener === 'empty-column'
              ? `[data-empty-add="${picker.slot.parentId ?? ''}"]`
              : picker.opener === 'empty-page'
                ? '[data-empty-page-add]'
                : null;
      const trigger = selector === null ? null : root?.querySelector(selector);
      if (trigger instanceof HTMLElement)
        trigger.focus({ preventScroll: true });
      else focusRegion(host);
    });
  }, [host, store]);

  const dismissPicker = useCallback(() => {
    store.closePicker();
  }, [store]);

  const pickEntry = useCallback(
    (entry: CatalogueEntry) => {
      const picker = store.getState().picker;
      if (picker === null) return;
      insertEntry(entry, slotPosition(picker.slot), true);
    },
    [insertEntry, store],
  );

  // Dragging: the toolbar's handle starts one, and a drop is a move like any
  // other structural write.
  const dragSession = useMemo(
    () =>
      createDragSession({
        store,
        frame: () => frameOf(host),
        onMove: moveTo,
        onKeyboardEnd: () => {
          // The handle is still there after a cancel and usually after a drop.
          requestAnimationFrame(() => {
            const handle = host.shadowRoot?.querySelector('[data-drag-handle]');
            if (handle instanceof HTMLElement)
              handle.focus({ preventScroll: true });
            else focusRegion(host);
          });
        },
      }),
    [host, store, moveTo],
  );
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      const { status: now, mode } = store.getState();
      if (now !== 'editing' || mode !== 'edit') dragSession.abandon();
    });
    return () => {
      unsubscribe();
      dragSession.abandon();
    };
  }, [store, dragSession]);
  const startDrag = useCallback(
    (id: string, origin: { x: number; y: number }) => {
      dragSession.startPointer({ kind: 'move', id }, origin);
    },
    [dragSession],
  );
  const liftDrag = useCallback(
    (id: string) => {
      dragSession.liftKeyboard(id);
    },
    [dragSession],
  );

  const retrySave = useCallback(() => {
    runnerRef.current?.retry();
  }, []);
  const undo = useCallback(() => {
    runnerRef.current?.undo();
  }, []);
  /** Undo from the toast: its button is about to go, so focus goes to the page. */
  const undoFromToast = useCallback(() => {
    runnerRef.current?.undo();
    focusRegion(host);
  }, [host]);
  const redo = useCallback(() => {
    runnerRef.current?.redo();
  }, []);

  const changeMode = useCallback(
    (next: EditorMode) => {
      const state = store.getState();
      if (state.status !== 'editing' || state.mode === next) return;
      store.setMode(next);
      store.announce(
        STRINGS[
          next === 'edit' ? 'announce.editMode' : 'announce.interactMode'
        ],
      );
      if (next === 'edit') focusStage(host, frameOf(host));
    },
    [host, store],
  );

  const climbSelection = useCallback(() => {
    const { model, selection } = store.getState();
    if (model !== null) selectAndAnnounce(store, climb(model, selection));
  }, [store]);

  // Edit mode claims the framed site's clicks and turns them into selections;
  // Interact releases them. The claim follows each document the frame loads
  // (a new document is a new window) and the mode, and the keys that switch
  // the mode and climb are heard from both documents.
  useEffect(() => {
    if (!hydrated || !editable || status !== 'editing') return undefined;
    const frame = frameOf(host);
    if (frame === null) return undefined;
    let frameWindow: Window | null = null;
    let releaseClaim: (() => void) | null = null;
    let releaseKeys: (() => void) | null = null;

    const structureKey = (event: KeyboardEvent, target: unknown): void => {
      const state = store.getState();
      const { model, selection } = state;
      if (state.mode !== 'edit' || model === null) return;
      const path = event.composedPath();
      const inRegion = path[0] instanceof Element && path[0].id === STAGE_ID;
      const inToolbar = path.some(
        (node) => node instanceof Element && node.hasAttribute('data-toolbar'),
      );
      const frameDocument = frame.contentDocument;
      const selected =
        selection.selectedId === null
          ? undefined
          : model.get(selection.selectedId);
      const axis =
        frameDocument === null || selected === undefined
          ? 'vertical'
          : measureSiblingAxis(
              frameDocument,
              model.childrenOf(selected.parentId).map((node) => node.id),
            );
      const action = structureKeyAction(event, target, {
        inRegion,
        inToolbar,
        axis,
      });
      if (action === null) return;
      event.preventDefault();
      switch (action.kind) {
        case 'sibling':
          selectAndAnnounce(
            store,
            action.direction === 'next'
              ? nextSibling(model, selection)
              : previousSibling(model, selection),
          );
          break;
        case 'edge':
          selectAndAnnounce(
            store,
            action.edge === 'first'
              ? firstSibling(model, selection)
              : lastSibling(model, selection),
          );
          break;
        case 'drill': {
          const result = drillFirst(model, selection);
          selectAndAnnounce(store, result.selection);
          if (result.openProperties && result.selection.selectedId !== null) {
            store.requestProperties(result.selection.selectedId);
          }
          break;
        }
        case 'climb':
          selectAndAnnounce(store, climb(model, selection));
          break;
        case 'move': {
          if (selected === undefined) break;
          const { id } = selected;
          // A held key makes presses faster than a save: each is built from the saved tree.
          runnerRef.current?.whenSaved(() => {
            const move = moveActionFor(store.getState(), id, action.direction);
            if (move === null) {
              store.announce(
                STRINGS[
                  action.direction === 'earlier'
                    ? 'toolbar.reason.atStart'
                    : 'toolbar.reason.atEnd'
                ],
              );
            } else {
              runnerRef.current?.perform(move.intent, move.entry);
            }
          });
          break;
        }
        case 'undo':
          runnerRef.current?.undo();
          break;
        case 'redo':
          runnerRef.current?.redo();
          break;
        case 'delete':
          if (selected !== undefined) {
            deleteItem(selected.id, inToolbar ? 'toolbar' : 'region');
          }
          break;
        case 'duplicate':
          if (selected !== undefined) duplicateItem(selected.id);
          break;
        case 'add': {
          const ctx = legalityContextOf(state);
          const slot =
            ctx === null ? null : slotAfter(ctx, selection.selectedId);
          if (slot !== null) openPicker(slot, 'key');
          break;
        }
      }
    };

    const onKey = (event: KeyboardEvent): void => {
      // A key something already used (the Properties sheet closing on Escape)
      // does nothing more here, so that Escape does not also climb the selection.
      if (event.defaultPrevented) return;
      // The delete confirmation owns the keyboard while it is open.
      if (store.getState().deleteRequest !== null) return;
      const target = event.composedPath()[0] ?? event.target;
      const action = keyAction(event, target);
      if (action === null) {
        structureKey(event, target);
        return;
      }
      if (action === 'toggle-mode') {
        event.preventDefault();
        changeMode(store.getState().mode === 'edit' ? 'interact' : 'edit');
      } else if (store.getState().mode === 'edit') {
        climbSelection();
      }
    };

    const sync = (): void => {
      const wanted = store.getState().mode === 'edit' && frameWindow !== null;
      if (wanted && releaseClaim === null && frameWindow !== null) {
        const claimed = frameWindow;
        const read = (x: number, y: number) => {
          const { model, selection } = store.getState();
          const frameDocument = claimed.document;
          if (model === null) return null;
          return { model, selection, chain: hitChain(frameDocument, x, y) };
        };
        releaseClaim = attachClaim(claimed, {
          onClick: (x, y) => {
            store.closePicker();
            const hit = read(x, y);
            if (hit === null) return;
            selectAndAnnounce(
              store,
              selectByClick(hit.model, hit.selection, hit.chain),
            );
            focusRegion(host);
          },
          onDoubleClick: (x, y) => {
            store.closePicker();
            const hit = read(x, y);
            if (hit === null) return;
            const drilled = drillByDoubleClick(
              hit.model,
              hit.selection,
              hit.chain,
            );
            selectAndAnnounce(store, drilled.selection);
            focusRegion(host);
            // A double-click on a leaf is the explicit ask for its Properties.
            if (
              drilled.openProperties &&
              drilled.selection.selectedId !== null
            ) {
              store.requestProperties(drilled.selection.selectedId);
            }
          },
        });
      } else if (!wanted && releaseClaim !== null) {
        releaseClaim();
        releaseClaim = null;
      }
      // While the claim holds, the site's own controls are out of the
      // keyboard order too.
      if (releaseClaim !== null) frame.setAttribute('tabindex', '-1');
      else frame.removeAttribute('tabindex');
    };

    const onLoad = (): void => {
      const frameDocument = frame.contentDocument;
      if (
        frameDocument === null ||
        frameDocument.URL === 'about:blank' ||
        frameDocument.readyState !== 'complete'
      ) {
        return;
      }
      releaseClaim?.();
      releaseClaim = null;
      releaseKeys?.();
      frameWindow = frame.contentWindow;
      frameWindow?.addEventListener('keydown', onKey);
      const listening = frameWindow;
      releaseKeys = () => {
        listening?.removeEventListener('keydown', onKey);
      };
      sync();
    };

    host.ownerDocument.addEventListener('keydown', onKey);
    frame.addEventListener('load', onLoad);
    sync();
    onLoad();
    const unsubscribe = store.subscribe(sync);
    return () => {
      unsubscribe();
      frame.removeEventListener('load', onLoad);
      host.ownerDocument.removeEventListener('keydown', onKey);
      releaseKeys?.();
      releaseClaim?.();
      frame.removeAttribute('tabindex');
    };
  }, [
    host,
    hydrated,
    editable,
    status,
    store,
    changeMode,
    climbSelection,
    deleteItem,
    duplicateItem,
    openPicker,
  ]);

  // The lock is held while editing: renewed on a heartbeat, again when the tab
  // is shown, and released when the page goes away.
  useEffect(() => {
    if (
      !hydrated ||
      session === null ||
      status !== 'editing' ||
      !session.lock.enabled ||
      session.lock.state !== 'mine'
    ) {
      return undefined;
    }
    const client = startLockClient({
      api,
      pageId: session.pageId,
      heartbeatSeconds: session.limits.heartbeatSeconds,
      onLock: (view) => {
        store.setLock(view);
      },
      onLost: (view) => {
        store.setLock(view);
      },
      onRenewState: (renewal) => {
        store.setRenewal(renewal);
      },
      onSessionEnded: () => {
        store.pauseFor('session-ended');
      },
    });
    lockRef.current = client;
    return () => {
      lockRef.current = null;
      client();
    };
  }, [hydrated, session, status, api, store]);

  // A page someone else holds is read once per heartbeat until it is free;
  // then it is opened again, which takes the lock and brings the latest tree.
  useEffect(() => {
    if (!hydrated || session === null || status !== 'locked') return undefined;
    return startLockWatch({
      api,
      pageId: session.pageId,
      heartbeatSeconds: session.limits.heartbeatSeconds,
      onHeld: (view) => {
        store.setLock(view);
      },
      onFree: () => {
        runOpen();
      },
      onSessionEnded: () => {
        store.pauseFor('session-ended');
      },
    });
  }, [hydrated, session, status, api, store, runOpen, watchRound]);

  // The "stopped editing" notice stays for eight seconds.
  const notice = useEditorStore(store, (state) => state.notice);
  useEffect(() => {
    if (notice?.kind !== 'lapsed') return undefined;
    const timer = globalThis.setTimeout(() => {
      if (store.getState().notice?.kind === 'lapsed') store.setNotice(null);
    }, LAPSED_NOTICE_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [notice, store]);

  /** Takes the page from its holder; the page is then opened again. */
  const takeOver = useCallback(async (): Promise<boolean> => {
    const pageId = store.getState().session?.pageId;
    if (pageId === undefined) return false;
    try {
      await api.lockAction(pageId, 'take-over');
    } catch {
      return false;
    }
    tookOver.current = true;
    runOpen();
    return true;
  }, [api, store, runOpen]);

  /** Renews the lock now, for the row that counts down to its lapse. */
  const keepEditing = useCallback(async (): Promise<boolean> => {
    return (await lockRef.current?.renew()) ?? false;
  }, []);

  // Leaving while something is unsaved: the browser asks, unless the editor
  // already chose to leave anyway.
  const leavingAnyway = useRef(false);
  useEffect(() => {
    const view = host.ownerDocument.defaultView;
    if (view === null || !editable) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (leavingAnyway.current) return;
      if (hasPending(store.getState().queue)) event.preventDefault();
    };
    view.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      view.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [host, editable, store]);

  const leaveProceed = useRef<(() => void) | null>(null);

  /** Exit edit mode and Log out: everything pending is sent first. */
  const leave = useCallback(
    async (proceed: () => void): Promise<void> => {
      // A change still being rendered is queued once its preview answers.
      await propertyWorkSettled();
      const runner = runnerRef.current;
      if (runner === null || !hasPending(store.getState().queue)) {
        proceed();
        return;
      }
      // A flush that throws is a save that did not happen: ask, never leave silently.
      let saved = false;
      try {
        saved = await runner.flush();
      } catch {
        saved = false;
      }
      if (saved) {
        proceed();
        return;
      }
      leaveProceed.current = proceed;
      store.askLeave();
    },
    [store, propertyWorkSettled],
  );

  const stay = useCallback(() => {
    leaveProceed.current = null;
    store.cancelLeave();
  }, [store]);

  const leaveAnyway = useCallback(() => {
    const proceed = leaveProceed.current;
    leaveProceed.current = null;
    store.cancelLeave();
    // The editor has chosen: the browser's own prompt would ask a second time.
    leavingAnyway.current = true;
    proceed?.();
  }, [store]);

  // Follow the document in the frame: its links, its title, a failed render
  // and a navigation that took it somewhere else.
  useEffect(() => {
    const frame = host.shadowRoot?.querySelector('iframe');
    if (!(frame instanceof HTMLIFrameElement)) return undefined;
    return watchFrame(frame, {
      frameUrl: island.frameUrl,
      visitorLocation: island.visitorLocation,
      onFailure: setFrameFailed,
    });
  }, [host, island.frameUrl, island.visitorLocation]);

  const reload = useCallback(() => {
    host.ownerDocument.defaultView?.location.reload();
  }, [host]);

  const showLayout = useCallback(
    (next: SidebarLayout) => {
      applyLayout(host, next);
      focusShownToggle(host, next);
      writeLayout(next);
      setLayout(next);
      // The drawer belongs to the full layout; it never stays open into either.
      store.closeDrawer();
    },
    [host, store],
  );

  const toggleLayout = useCallback(() => {
    showLayout(layout === 'full' ? 'framed' : 'full');
  }, [layout, showLayout]);

  // The drawer pushes the frame: its column is on the host while it is open
  // in the full layout, and the framed page keeps its scroll position.
  const drawerOpen = useEditorStore(store, (state) => state.drawer !== null);
  useLayoutEffect(() => {
    setDrawerColumn(host, frameOf(host), layout === 'full' && drawerOpen);
  }, [host, layout, drawerOpen]);

  // A rail button opens the drawer, unless the pushed frame would be narrower
  // than the site can be used in: then the sidebar layout is shown instead,
  // with the sheet open if Properties were asked for.
  const openDrawer = useCallback(
    (opener: DrawerOpener) => {
      const frame = frameOf(host);
      const closed = store.getState().drawer === null;
      if (
        closed &&
        frame !== null &&
        !drawerFits(frame.getBoundingClientRect().width)
      ) {
        showLayout('framed');
        // The sheet belongs to the layout shown, so it opens after the switch.
        if (opener === 'properties') store.openProperties();
        return;
      }
      store.openDrawer(opener);
    },
    [host, store, showLayout],
  );

  // An explicit ask for an item's Properties (a double-click, the toolbar
  // button) shows them: in the full layout that opens the drawer, in the same
  // store update's wake so the panel's own focus move is the one that lands.
  useEffect(() => {
    let seen = store.getState().propertiesRequest?.token ?? 0;
    return store.subscribe(() => {
      const token = store.getState().propertiesRequest?.token ?? 0;
      if (token === seen) return;
      seen = token;
      // An open drawer keeps the button that opened it, for focus to return to.
      if (layout === 'full' && store.getState().drawer === null) {
        openDrawer('properties');
      }
    });
  }, [store, layout, openDrawer]);

  return (
    <ShellApp
      island={island}
      hydrated={hydrated}
      layout={layout}
      onToggleLayout={toggleLayout}
      frameFailed={frameFailed}
      onReload={reload}
      editor={
        editable
          ? {
              store,
              onMode: changeMode,
              onOpenDrawer: openDrawer,
              onTakeOver: takeOver,
              onKeepEditing: keepEditing,
              signInHref: `/cms?next=${encodeURIComponent(island.visitorLocation)}`,
              onLeave: leave,
              onStay: stay,
              onLeaveAnyway: leaveAnyway,
              onRetry: retrySave,
              onUndo: undo,
              onRedo: redo,
              onMove: moveItem,
              onDuplicate: duplicateItem,
              onDelete: deleteFromToolbar,
              onConfirmDelete: confirmDelete,
              onCancelDelete: cancelDelete,
              onToastUndo: undoFromToast,
              onOpenPicker: openPicker,
              onClosePicker: closePicker,
              onDismissPicker: dismissPicker,
              onPick: pickEntry,
              onDragStart: startDrag,
              onLiftDrag: liftDrag,
              onPropertiesChange: changeProperties,
              onPropertiesBlur: blurProperties,
              onLayoutChange: changeLayout,
              columnAxis,
              onAddColumn: addColumnLast,
              onMoveColumn: moveColumnFromPanel,
              onRemoveColumn: removeFromPanel,
            }
          : undefined
      }
    />
  );
}

/** The shell with the query client the editing session's requests run on. */
function ShellRoot(props: {
  readonly host: HTMLElement;
  readonly island: ShellIsland;
  readonly options: BootEditorOptions;
}): ReactElement {
  const [client] = useState<QueryClient>(createEditorQueryClient);
  return (
    <QueryClientProvider client={client}>
      <Shell {...props} />
    </QueryClientProvider>
  );
}

/**
 * Hydrates the shell the server rendered inside the host's shadow root. The
 * iframe is part of that markup with an unchanged `src`, so hydration neither
 * recreates nor reloads it. Returns the React root, or `null` when the
 * server's root element is missing.
 */
export function mountShell(
  host: HTMLElement,
  shadowRoot: ShadowRoot,
  island: ShellIsland,
  options: BootEditorOptions = {},
): Root | null {
  const container = shadowRoot.getElementById(SHELL_ROOT_ID);
  if (container === null) return null;
  return hydrate(
    container,
    <ShellRoot host={host} island={island} options={options} />,
  );
}
