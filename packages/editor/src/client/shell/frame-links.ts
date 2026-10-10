/**
 * What happens when a link is clicked inside the framed site.
 *
 * The frame is a viewport onto the site, so a link that would load another
 * page in it has to be followed by the whole shell instead: the editor must
 * keep framing the page it is editing. This module decides, from the link
 * alone, which of three things happens and carries it out for the one case
 * where the browser's own default is wrong. It never takes over anything the
 * site handles itself.
 *
 * - `follow-top`: the link leads to another document of this site. The whole
 *   page navigates to the target in edit mode.
 * - `new-tab`: the link leads to another site. It opens in a new tab and the
 *   shell stays.
 * - `allow`: everything else keeps the browser's behaviour, the site's own
 *   included: links to a spot on the same page, downloads, links that name
 *   their own window, non-web schemes, and any click with a modifier key or a
 *   button other than the primary one.
 *
 * The listener is attached once to the frame's window and runs in the bubble
 * phase, after the site's own handlers, and acts only when none of them
 * prevented the default. It never stops an event from travelling on, so the
 * site's click, keyboard and scroll handling is untouched.
 */
import { EDIT_PARAM } from '@plakboek/render';

/** The click that reached the frame's window. */
export type FrameClick = {
  /** The link's `href`; a relative one is resolved against `frameUrl`. */
  readonly href: string;
  /** The URL of the document the link was clicked in. */
  readonly frameUrl: string;
  /** The origin of the shell page, which is the site's origin. */
  readonly topOrigin: string;
  /** The link's `target` attribute, or the empty string. */
  readonly target: string;
  /** Whether the link has a `download` attribute. */
  readonly download: boolean;
  readonly modifiers: {
    /** `MouseEvent.button`: 0 is the primary button. */
    readonly button: number;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  };
};

export type FrameNavigation =
  | {
      readonly action: 'follow-top';
      /** Path and query of the target, with `_edit=1` and no other `_edit`. */
      readonly location: string;
    }
  | { readonly action: 'new-tab'; readonly url: string }
  | { readonly action: 'allow' };

const ALLOW: FrameNavigation = { action: 'allow' };

/** Targets that mean "this window or one of its parents": the shell is the
 * top window, so all three end up as a navigation of the shell. */
const SAME_WINDOW_TARGETS = new Set(['', '_self', '_top', '_parent']);

function parseUrl(value: string, base: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** A query string without any `_edit` parameter, as raw text. */
function queryWithoutEdit(search: string): string {
  return search
    .slice(1)
    .split('&')
    .filter((segment) => {
      if (segment === '') return false;
      return new URLSearchParams(segment).keys().next().value !== EDIT_PARAM;
    })
    .join('&');
}

/** The location of the edit shell for a page: its path and query with every
 * `_edit` removed and `_edit=1` added. */
export function editShellLocation(url: URL): string {
  const query = [queryWithoutEdit(url.search), `${EDIT_PARAM}=1`]
    .filter((part) => part !== '')
    .join('&');
  return `${url.pathname}?${query}`;
}

/** Whether two URLs are the same document: the same path and the same query
 * once `_edit` is set aside, whatever their fragments. */
function isSameDocument(a: URL, b: URL): boolean {
  return (
    a.origin === b.origin &&
    a.pathname === b.pathname &&
    queryWithoutEdit(a.search) === queryWithoutEdit(b.search)
  );
}

/** Decides what a click on a link in the frame should do. Pure. */
export function classifyFrameNavigation(click: FrameClick): FrameNavigation {
  const { modifiers } = click;
  if (
    modifiers.button !== 0 ||
    modifiers.ctrl ||
    modifiers.meta ||
    modifiers.shift ||
    modifiers.alt
  ) {
    return ALLOW;
  }
  if (click.download) return ALLOW;
  if (!SAME_WINDOW_TARGETS.has(click.target.trim().toLowerCase())) {
    return ALLOW;
  }

  const frame = parseUrl(click.frameUrl, click.frameUrl);
  const target = parseUrl(click.href, click.frameUrl);
  if (frame === null || target === null) return ALLOW;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return ALLOW;
  }
  if (target.origin !== click.topOrigin) {
    return { action: 'new-tab', url: target.href };
  }
  // A link to a spot on the page the frame already shows scrolls the frame.
  if (target.href.includes('#') && isSameDocument(target, frame)) return ALLOW;
  return { action: 'follow-top', location: editShellLocation(target) };
}

/** What the listener needs from the shell to carry a decision out. */
export type FrameLinkShell = {
  readonly topOrigin: string;
  /** Navigates the whole page to a same-site location. */
  readonly followTop: (location: string) => void;
  /** Opens a URL in a new tab that cannot reach back to the shell. */
  readonly openTab: (url: string) => void;
};

/** The element a click landed in, when it is a link with an `href`. Elements
 * of the frame's document belong to another realm, so this checks for the
 * method instead of using `instanceof`. */
function linkOf(target: EventTarget | null): Element | null {
  const candidate = target as { closest?: unknown } | null;
  if (candidate === null || typeof candidate.closest !== 'function') {
    return null;
  }
  return (target as Element).closest('a[href], area[href]');
}

const attached = new WeakSet<Window>();

/**
 * Attaches the one click listener to the frame's window. Safe to call again
 * for the same window: it attaches once. A new document in the frame is a new
 * window, so the caller attaches on every load. Returns a function that
 * detaches it.
 */
export function attachFrameLinks(
  frameWindow: Window,
  shell: FrameLinkShell,
): () => void {
  if (attached.has(frameWindow)) return () => undefined;
  attached.add(frameWindow);

  const listener = (event: MouseEvent): void => {
    // The site handled it: nothing is left for the shell to do.
    if (event.defaultPrevented) return;
    const link = linkOf(event.target);
    if (link === null) return;
    // The `href` as the browser resolves it, `<base>` included.
    const href =
      parseUrl(link.getAttribute('href') ?? '', link.ownerDocument.baseURI)
        ?.href ?? '';
    const decision = classifyFrameNavigation({
      href,
      frameUrl: link.ownerDocument.URL,
      topOrigin: shell.topOrigin,
      target: link.getAttribute('target') ?? '',
      download: link.hasAttribute('download'),
      modifiers: {
        button: event.button,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
      },
    });
    if (decision.action === 'allow') return;
    event.preventDefault();
    if (decision.action === 'follow-top') shell.followTop(decision.location);
    else shell.openTab(decision.url);
  };

  frameWindow.addEventListener('click', listener);
  return () => {
    frameWindow.removeEventListener('click', listener);
    attached.delete(frameWindow);
  };
}
