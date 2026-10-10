/**
 * What the server hands the client chrome in the JSON island of the edit
 * shell: only what the chrome needs to draw itself and nothing a client could
 * use to grant itself anything. Shared by the server (which writes it) and the
 * client (which reads and validates it), so this module imports nothing.
 */
export type ShellIsland = {
  readonly kind: 'shell';
  /** `read-only` for a signed-in user who cannot edit pages. */
  readonly mode: 'edit' | 'read-only';
  readonly user: { readonly name: string; readonly email: string };
  /** The page without `_edit`: where Exit and Log out lead back to. */
  readonly visitorLocation: string;
  /** The same page with `_edit=frame`: the iframe's source. */
  readonly frameUrl: string;
  /** Where the Log out form posts. */
  readonly logoutPath: string;
};

/** The custom element the shell lives in. */
export const HOST_TAG = 'plakboek-editor';

/** The element inside the shadow root the shell is rendered into. */
export const SHELL_ROOT_ID = 'plakboek-shell-root';

/** The element id of the JSON script that carries the island. */
export const ISLAND_ELEMENT_ID = 'plakboek-editor-data';

/** The `<meta name>` a failed frame document carries so the shell can show
 * its own error panel instead. Shared by the server (which writes it) and the
 * client (which looks for it). */
export const FRAME_ERROR_MARKER = 'plakboek-frame-error';
