/**
 * The default document composer (D-11). It proves a page can be served end to
 * end in this phase; the host's scaffold later replaces it with its own
 * header, footer and root templates behind the same `RenderDocument` shape.
 *
 * It never adds a script: a visitor page ships zero client JavaScript by
 * default (D-10). The only script on a visitor page is the editor bootstrap
 * the request handler adds itself.
 */
import { renderHeadHtml, type DocumentInput } from './head.js';

/** Escapes a value for use inside a double- or single-quoted attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Wraps already-rendered body markup in a complete HTML document. */
export function renderDefaultDocument(input: DocumentInput): string {
  const lang = escapeHtmlAttribute(input.head.lang);
  return (
    `<!DOCTYPE html><html lang="${lang}"><head>` +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    renderHeadHtml(input.head) +
    `</head><body>${input.body}</body></html>`
  );
}
