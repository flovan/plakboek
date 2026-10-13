import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { hydrateRoot as hydrate, type Root } from 'react-dom/client';
import type { SidebarLayout } from '../../chrome/controls.js';
import { ShellApp } from '../../chrome/shell.js';
import { SHELL_ROOT_ID, type ShellIsland } from '../../chrome/island.js';
import type { BlockEditHooks } from '@plakboek/render';
import type { BootEditorOptions } from '../boot.js';
import { loadBlockEditModules } from '../frame/block-edit-loader.js';
import { watchFrame } from './frame-watch.js';
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

function ShellRoot(props: {
  readonly host: HTMLElement;
  readonly island: ShellIsland;
  readonly options: BootEditorOptions;
}): ReactElement {
  const { host, island, options } = props;
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
  // only. The map waits here for the frame runtime that calls the hooks.
  const [, setBlockHooks] = useState<ReadonlyMap<string, BlockEditHooks>>(
    () => new Map(),
  );
  const blockEdit = options.blockEdit;
  useEffect(() => {
    if (!hydrated || blockEdit === undefined) return undefined;
    let cancelled = false;
    void loadBlockEditModules(blockEdit).then((loaded) => {
      if (!cancelled) setBlockHooks(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, blockEdit]);

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
    />
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
