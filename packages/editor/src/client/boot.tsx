import { HOST_TAG } from '../chrome/island.js';
import type { BlockEditLoaders } from './frame/block-edit-loader.js';
import { readIsland } from './island.js';
import { mountLogin } from './login/mount.js';
import { mountShell } from './shell/mount.js';

/** What the editor's client chunk hands to `bootEditor`. */
export type BootEditorOptions = {
  /**
   * The host's block edit modules, loaded once after the shell hydrates. The
   * `plakboek()` Vite plugin supplies them; a host never passes this itself.
   */
  readonly blockEdit?: BlockEditLoaders;
};

/**
 * Boots the editor on the page the server rendered: finds the host and its
 * open shadow root, reads the island and mounts what the island names.
 * Anything it does not recognise does nothing, and the server-rendered chrome
 * simply stays as it is.
 */
export function bootEditor(
  doc: Document = document,
  options: BootEditorOptions = {},
): void {
  const host = doc.querySelector<HTMLElement>(HOST_TAG);
  const shadowRoot = host?.shadowRoot ?? null;
  if (host === null || shadowRoot === null) return;
  const island = readIsland(doc);
  if (island === null) return;
  if (island.kind === 'shell') mountShell(host, shadowRoot, island, options);
  else mountLogin(host, shadowRoot, island);
}
