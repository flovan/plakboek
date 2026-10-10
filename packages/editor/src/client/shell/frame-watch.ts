/**
 * Keeps the shell in step with the document inside its frame.
 *
 * Every time the frame finishes loading a document the shell:
 *
 * - attaches the link handler to that document's window (a new document is a
 *   new window, so the handler from the last one is gone),
 * - reports whether the document is the editor's own render-failure page, so
 *   the shell can show its panel instead,
 * - sets its own title to the page's, followed by the product name,
 * - and checks the frame is still on the page it was opened for. A script or
 *   a form that navigated the frame elsewhere is followed by the whole page,
 *   in edit mode, so the editor never frames a page it was not opened for.
 *
 * The frame may have finished loading before the editor's script ran, so the
 * watcher also looks at the document that is already there.
 */
import { FRAME_ERROR_MARKER } from '../../chrome/island.js';
import { STRINGS } from '../../chrome/strings.js';
import { attachFrameLinks, editShellLocation } from './frame-links.js';

export type FrameWatchOptions = {
  /** The URL the frame was opened on: the page plus `_edit=frame`. */
  readonly frameUrl: string;
  /** The page without `_edit`, where the shell goes back to when the frame
   * ends up somewhere it cannot follow. */
  readonly visitorLocation: string;
  /** Called with true when the frame holds the render-failure page. */
  readonly onFailure: (failed: boolean) => void;
};

/** The title of the shell for a page title. */
export function shellTitle(pageTitle: string): string {
  const product = STRINGS['product.name'];
  const title = pageTitle.trim();
  return title === '' ? product : `${title} · ${product}`;
}

function withoutHash(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`;
}

/**
 * Starts watching a frame. Returns a function that stops. Nothing here throws:
 * a document the shell cannot read (another origin) is treated as a
 * navigation it cannot follow.
 */
export function watchFrame(
  frame: HTMLIFrameElement,
  options: FrameWatchOptions,
): () => void {
  const topDocument = frame.ownerDocument;
  const view = topDocument.defaultView;
  if (view === null) return () => undefined;
  const topWindow: Window = view;

  const expected = new URL(options.frameUrl, topWindow.location.href);
  let handled: Document | null = null;

  function followTop(location: string): void {
    // Never navigate to where the shell already is: that would reload it
    // forever if the frame kept ending up elsewhere.
    const here = `${topWindow.location.pathname}${topWindow.location.search}`;
    if (location === here) return;
    topWindow.location.assign(location);
  }

  function inspect(): void {
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) {
      // Not readable: the frame holds a page of another origin.
      followTop(options.visitorLocation);
      return;
    }
    const href = frameDocument.URL;
    if (href === 'about:blank' || handled === frameDocument) return;
    handled = frameDocument;

    const current = new URL(href);
    if (withoutHash(current) !== withoutHash(expected)) {
      followTop(
        current.origin === topWindow.location.origin
          ? editShellLocation(current)
          : options.visitorLocation,
      );
      return;
    }

    const frameWindow = frameDocument.defaultView;
    if (frameWindow !== null) {
      attachFrameLinks(frameWindow, {
        topOrigin: topWindow.location.origin,
        followTop,
        openTab: (url) => {
          topWindow.open(url, '_blank', 'noopener');
        },
      });
    }
    const failed =
      frameDocument.querySelector(`meta[name="${FRAME_ERROR_MARKER}"]`) !==
      null;
    // The failure page's own title is the product name: do not repeat it.
    topDocument.title = shellTitle(failed ? '' : frameDocument.title);
    options.onFailure(failed);
  }

  frame.addEventListener('load', inspect);
  if (frame.contentDocument?.readyState === 'complete') inspect();
  return () => {
    frame.removeEventListener('load', inspect);
  };
}
