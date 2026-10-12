import { CHROME_CSS, CHROME_CSS_SHA256 } from '../generated/chrome-css.js';

const sheets = new WeakMap<Document, CSSStyleSheet>();

/**
 * The chrome stylesheet for one document, built with that document's own
 * `CSSStyleSheet` constructor and cached per document. A constructed sheet
 * can only be adopted by shadow roots of the document whose window made it,
 * so the editor in the top document and any chrome inside a frame document
 * each get their own sheet.
 */
export function chromeStyleSheet(doc: Document): CSSStyleSheet {
  const cached = sheets.get(doc);
  if (cached !== undefined) return cached;
  const view = doc.defaultView;
  if (view === null) {
    throw new Error(
      'chromeStyleSheet needs a document that belongs to a window',
    );
  }
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(CHROME_CSS);
  sheets.set(doc, sheet);
  return sheet;
}

/** Adopts the chrome stylesheet into a shadow root, once. */
export function adoptChromeStyles(root: ShadowRoot): void {
  const sheet = chromeStyleSheet(root.ownerDocument);
  if (root.adoptedStyleSheets.includes(sheet)) return;
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

/**
 * The `<style>` markup for a declarative shadow root, so chrome paints
 * before any script runs. Hosts with a strict `style-src` allow it with
 * `CHROME_STYLE_CSP_HASH`; constructed sheets are not subject to it.
 */
export function chromeStyleElement(): string {
  return `<style>${CHROME_CSS}</style>`;
}

/** The `style-src` source expression that allows `chromeStyleElement()`. */
export const CHROME_STYLE_CSP_HASH = `sha256-${CHROME_CSS_SHA256}`;
