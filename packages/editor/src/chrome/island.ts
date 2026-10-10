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

/** The steps the login document can open on. Each is a card in the same
 * dialog; `sign-in` is the plain `/cms` entry and the rest are the landings
 * of emailed links and the two-factor set-up a role may require. */
export type LoginStep =
  | 'sign-in'
  | 'set-password'
  | 'reset-password'
  | 'magic-landing'
  | 'invalid-link'
  | 'enrol';

/** What kind of link an invalid-link step stands in for, so its one button
 * can offer the right way forward. */
export type LinkKind = 'invite' | 'reset' | 'sign-in';

/**
 * What the server hands the client of the login document in its JSON island.
 * It never carries a link token: the client reads that from the address bar
 * itself and removes it there.
 */
export type LoginIsland = {
  readonly kind: 'login';
  readonly step: LoginStep;
  /** The same-origin page the backdrop shows and the user returns to. */
  readonly next: string;
  /** Present on `invalid-link` only. */
  readonly linkKind?: LinkKind;
  /** The role keys that must set up two-step sign-in. */
  readonly twoFactorRequiredRoles: readonly string[];
  /** The signed-in user's address, present on `enrol` only. */
  readonly email?: string;
};

/** The element inside the login shadow root the card is rendered into. */
export const LOGIN_ROOT_ID = 'plakboek-login-root';
