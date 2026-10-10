import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { hydrateRoot as hydrate, type Root } from 'react-dom/client';
import type { SidebarLayout } from '../../chrome/controls.js';
import { ShellApp } from '../../chrome/shell.js';
import { SHELL_ROOT_ID, type ShellIsland } from '../../chrome/island.js';
import { applyLayout, readLayout, writeLayout } from './layout.js';

function ShellRoot(props: {
  readonly host: HTMLElement;
  readonly island: ShellIsland;
}): ReactElement {
  const { host, island } = props;
  // The first client render must match the server markup, which was rendered
  // before hydration and always in the framed state, so `hydrated` and
  // `layout` change only after it.
  const [hydrated, setHydrated] = useState(false);
  const [layout, setLayout] = useState<SidebarLayout>('framed');
  useEffect(() => {
    // The pre-paint script already set the attribute from storage; applying
    // the stored value again covers a browser that blocked that script.
    const stored = readLayout();
    applyLayout(host, stored);
    setLayout(stored);
    setHydrated(true);
    host.dataset.hydrated = '';
  }, [host]);

  const toggleLayout = useCallback(() => {
    const next: SidebarLayout = layout === 'full' ? 'framed' : 'full';
    applyLayout(host, next);
    writeLayout(next);
    setLayout(next);
  }, [host, layout]);

  return (
    <ShellApp
      island={island}
      hydrated={hydrated}
      layout={layout}
      onToggleLayout={toggleLayout}
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
): Root | null {
  const container = shadowRoot.getElementById(SHELL_ROOT_ID);
  if (container === null) return null;
  return hydrate(container, <ShellRoot host={host} island={island} />);
}
