import { HOST_TAG } from '../chrome/island.js';
import { readIsland } from './island.js';
import { mountLogin } from './login/mount.js';
import { mountShell } from './shell/mount.js';

/**
 * Boots the editor on the page the server rendered: finds the host and its
 * open shadow root, reads the island and mounts what the island names.
 * Anything it does not recognise does nothing, and the server-rendered chrome
 * simply stays as it is.
 */
export function bootEditor(doc: Document = document): void {
  const host = doc.querySelector<HTMLElement>(HOST_TAG);
  const shadowRoot = host?.shadowRoot ?? null;
  if (host === null || shadowRoot === null) return;
  const island = readIsland(doc);
  if (island === null) return;
  if (island.kind === 'shell') mountShell(host, shadowRoot, island);
  else mountLogin(host, shadowRoot, island);
}
