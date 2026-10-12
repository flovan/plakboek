import type { ReactElement } from 'react';
import type { SidebarLayout } from '../controls.js';
import { SpinnerIcon } from '../icons.js';
import { LOGOUT_PATH, type ShellIsland } from '../island.js';
import { Sidebar } from '../sidebar.js';
import { STRINGS } from '../strings.js';

/** A rectangle in viewport pixels. */
export type PixelRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type TransitionChromeProps = {
  readonly user: { readonly name: string; readonly email: string };
  /** The page the editor is about to open in edit mode. */
  readonly next: string;
  readonly layout: SidebarLayout;
  /** Set once the edit page is slow: where the frame will be, to centre the
   * spinner in. */
  readonly openingIn: PixelRect | null;
};

/** Places an element at a rectangle through the style object, which a
 * Content-Security-Policy without inline styles permits (an attribute in the
 * markup would not be). */
function placeAt(rect: PixelRect): (element: HTMLElement | null) => void {
  return (element) => {
    if (element === null) return;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  };
}

/**
 * What the login document draws while it hands over to the edit shell: the
 * sidebar (or the rail) the shell is about to show, so it can slide in, and
 * the spinner of a slow answer. The sidebar is the real one, signed-in user
 * name included, but inert: nothing in it can be used before the shell
 * replaces this document.
 */
export function TransitionChrome(props: TransitionChromeProps): ReactElement {
  const { user, next, layout, openingIn } = props;
  const island: ShellIsland = {
    kind: 'shell',
    mode: 'edit',
    user,
    visitorLocation: next,
    frameUrl: next,
    logoutPath: LOGOUT_PATH,
  };
  return (
    <>
      <div
        className="pk-login-sidebar"
        data-transition="sidebar"
        aria-hidden
        inert
      >
        <Sidebar island={island} hydrated={false} layout={layout} />
      </div>
      {openingIn === null ? null : (
        <div
          ref={placeAt(openingIn)}
          className="pk-login-opening"
          data-transition="opening"
        >
          <SpinnerIcon size={20} className="text-text-muted" />
          <span role="status" className="sr-only">
            {STRINGS['transition.opening']}
          </span>
        </div>
      )}
    </>
  );
}
