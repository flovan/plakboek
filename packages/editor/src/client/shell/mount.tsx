import {
  QueryClientProvider,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { hydrateRoot as hydrate, type Root } from 'react-dom/client';
import type { SidebarLayout } from '../../chrome/controls.js';
import { ShellApp } from '../../chrome/shell.js';
import { SHELL_ROOT_ID, type ShellIsland } from '../../chrome/island.js';
import { STAGE_ID } from '../../chrome/stage.js';
import { STRINGS } from '../../chrome/strings.js';
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
import { createApiClient } from '../session/api-client.js';
import { startLockClient } from '../session/lock-client.js';
import { moveActionFor } from '../session/move-action.js';
import type { MoveDirection } from '../session/move-targets.js';
import { createEditorQueryClient } from '../session/query-client.js';
import { createSaveRunner, type SaveRunner } from '../session/save-runner.js';
import {
  climb,
  drillByDoubleClick,
  drillFirst,
  firstSibling,
  lastSibling,
  nextSibling,
  previousSibling,
  selectByClick,
} from '../session/scope.js';
import { selectAndAnnounce } from '../session/selection-announcement.js';
import {
  createEditorStore,
  useEditorStore,
  type EditorMode,
} from '../session/store.js';
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
      ? '[data-rail] button[aria-pressed]'
      : '[data-sidebar] button[aria-pressed]',
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
    frame.addEventListener('load', attach);
    attach();

    let previous = store.getState();
    const unsubscribe = store.subscribe(() => {
      const next = store.getState();
      if (next.mode !== previous.mode) runtime.setMode(next.mode);
      if (next.selection !== previous.selection) {
        const { model } = next;
        const { selectedId } = next.selection;
        runtime.select(
          selectedId,
          model === null || selectedId === null
            ? []
            : model
                .ancestorsOf(selectedId)
                .map((ancestor) => ancestor.id)
                .reverse(),
        );
      }
      previous = next;
    });
    return () => {
      unsubscribe();
      frame.removeEventListener('load', attach);
      hooksRef.current = null;
      runtime.dispose();
    };
  }, [host, hydrated, editable, blockHooks, store]);

  // Opening the page for editing: one request after hydration, which takes
  // the lock and brings the page tree. A page that was stored before columns
  // existed comes back upgraded, so the frame is reloaded to show it.
  const open = useMutation({
    mutationFn: async () =>
      await api.open(pathOfLocation(island.visitorLocation)),
    onSuccess: (opened) => {
      store.opened(opened);
      if (opened.upgraded) {
        frameOf(host)?.contentWindow?.location.replace(island.frameUrl);
      }
    },
    onError: (error) => {
      const code: unknown = Reflect.get(error, 'code');
      store.failedToOpen(typeof code === 'string' ? code : null);
    },
  });
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
    return () => {
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

  const moveItem = useCallback(
    (id: string, direction: MoveDirection) => {
      const action = moveActionFor(store.getState(), id, direction);
      if (action !== null)
        runnerRef.current?.perform(action.intent, action.entry);
    },
    [store],
  );

  const retrySave = useCallback(() => {
    runnerRef.current?.retry();
  }, []);
  const undo = useCallback(() => {
    runnerRef.current?.undo();
  }, []);
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
          const move = moveActionFor(state, selected.id, action.direction);
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
          break;
        }
        case 'undo':
          runnerRef.current?.undo();
          break;
        case 'redo':
          runnerRef.current?.redo();
          break;
      }
    };

    const onKey = (event: KeyboardEvent): void => {
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
            const hit = read(x, y);
            if (hit === null) return;
            selectAndAnnounce(
              store,
              selectByClick(hit.model, hit.selection, hit.chain),
            );
            focusRegion(host);
          },
          onDoubleClick: (x, y) => {
            const hit = read(x, y);
            if (hit === null) return;
            selectAndAnnounce(
              store,
              drillByDoubleClick(hit.model, hit.selection, hit.chain).selection,
            );
            focusRegion(host);
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
  }, [host, hydrated, editable, status, store, changeMode, climbSelection]);

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
    return startLockClient({
      api,
      pageId: session.pageId,
      heartbeatSeconds: session.limits.heartbeatSeconds,
      onLock: (view) => {
        store.setLock(view);
      },
      onLost: (view) => {
        store.setLock(view);
      },
    });
  }, [hydrated, session, status, api, store]);

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

  const toggleLayout = useCallback(() => {
    const next: SidebarLayout = layout === 'full' ? 'framed' : 'full';
    applyLayout(host, next);
    focusShownToggle(host, next);
    writeLayout(next);
    setLayout(next);
  }, [host, layout]);

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
              onRetry: retrySave,
              onUndo: undo,
              onRedo: redo,
              onMove: moveItem,
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
