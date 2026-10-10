import { useEffect, useState, type ReactElement } from 'react';
import { hydrateRoot as hydrate, type Root } from 'react-dom/client';
import { ShellApp } from '../../chrome/shell.js';
import { SHELL_ROOT_ID, type ShellIsland } from '../../chrome/island.js';

function ShellRoot(props: {
  readonly host: HTMLElement;
  readonly island: ShellIsland;
}): ReactElement {
  const { host, island } = props;
  // The first client render must match the server markup, which was rendered
  // before hydration, so `hydrated` flips only after it.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
    host.dataset.hydrated = '';
  }, [host]);
  return <ShellApp island={island} hydrated={hydrated} />;
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
