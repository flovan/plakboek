/**
 * The in-frame chrome host.
 *
 * While a page is being edited in Edit mode, the framed document holds exactly
 * one extra element: a `plakboek-chrome` host appended to `<html>`, after
 * `<body>`, with a closed shadow root. Chrome that belongs on the page (outlines,
 * chips, toolbars) is drawn into it, so it scrolls with the document natively
 * and follows rubber-band overscroll for free.
 *
 * The host is built not to change the site and not to be changed by it:
 *
 * - its layout rules are `!important` rules inside the shadow tree, and for
 *   important declarations the inner tree wins over the site's own rules;
 * - it is absolute at the document origin, as wide as the document and as
 *   tall as the `<html>` box, clipped, and ignores the pointer, so it adds no
 *   scrollable overflow and catches no event meant for the site;
 * - its height reaches it through a constructed sheet adopted by the shadow
 *   root, so the site document gets no `style` attribute, no `<style>` element
 *   and no adopted sheet;
 * - it is tracked with a `ResizeObserver`, never a scroll listener.
 *
 * Every object here is made with the frame window's own constructors, and the
 * frame's nodes are only ever touched through their own methods.
 */
import { chromeStyleSheet } from '../../chrome/styles.js';

/** The host element's tag name. */
export const CHROME_HOST_TAG = 'plakboek-chrome';

/** The class of the fixed sub-layer that covers the frame's viewport. */
export const CHROME_VIEWPORT_CLASS = 'pk-chrome-viewport';

export type ChromeHost = {
  /** The element in the frame document's `<html>`. */
  readonly element: Element;
  /** Its closed root; only this module and the portal target hold it. */
  readonly root: ShadowRoot;
  /** The fixed layer inside the host that covers the frame's viewport. */
  readonly viewport: Element;
  /** Mirrors the shell host's `data-theme`; `null` follows the browser. */
  setTheme(theme: string | null): void;
  /** Stops observing and removes the host from its document. */
  dispose(): void;
};

export type ChromeHostOptions = {
  readonly theme: string | null;
};

/** The sheet that carries the document-dependent height of one host. */
function heightRule(height: number): string {
  return `:host(${CHROME_HOST_TAG}){--pk-chrome-height:${height}px}`;
}

/**
 * Builds the host for one frame document. Call it again for a new document: a
 * reload is a new document, so it needs a new host.
 */
export function createChromeHost(
  frameDocument: Document,
  options: ChromeHostOptions,
): ChromeHost {
  const view = frameDocument.defaultView;
  if (view === null) {
    throw new Error(
      'createChromeHost needs a document that belongs to a window',
    );
  }
  const html = frameDocument.documentElement;
  const element = frameDocument.createElement(CHROME_HOST_TAG);
  const root = element.attachShadow({ mode: 'closed' });
  const heightSheet = new view.CSSStyleSheet();
  heightSheet.replaceSync(heightRule(0));
  root.adoptedStyleSheets = [chromeStyleSheet(frameDocument), heightSheet];
  const viewport = frameDocument.createElement('div');
  viewport.className = CHROME_VIEWPORT_CLASS;
  root.append(viewport);

  const setTheme = (theme: string | null): void => {
    if (theme === null) element.removeAttribute('data-theme');
    else element.setAttribute('data-theme', theme);
  };
  setTheme(options.theme);
  html.append(element);

  // The exact, fractional height of the `<html>` box: rounding it up grows the
  // document's own scroll height by a pixel. The host's own box is not part of
  // `<html>`'s, so there is no feedback loop.
  let applied = -1;
  const measure = (): void => {
    const height = html.getBoundingClientRect().height;
    if (height === applied) return;
    applied = height;
    heightSheet.replaceSync(heightRule(height));
  };
  measure();
  const observer = new view.ResizeObserver(measure);
  observer.observe(html);
  if (frameDocument.body !== null) observer.observe(frameDocument.body);

  return {
    element,
    root,
    viewport,
    setTheme,
    dispose() {
      observer.disconnect();
      element.remove();
    },
  };
}
