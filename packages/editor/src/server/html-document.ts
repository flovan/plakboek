/**
 * The documents the editor itself serves (the edit shell and the frame error
 * page), as plain strings: their header sets, the Content-Security-Policy of
 * the shell, and the escaping every dynamic value goes through.
 *
 * Nothing here reads a request. Markup that carries dynamic values is built
 * by React (which escapes them) or by `escapeHtml` below, and handed in as a
 * string by the caller.
 */
import { createHash } from 'node:crypto';

/** Replaces the five characters that can end or open markup. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * JSON for a `<script type="application/json">` island. `<`, `>` and `&` are
 * written as unicode escapes so no value can close the script or open a
 * comment, and U+2028 and U+2029, which JSON allows raw but older script
 * parsers treat as line terminators, are escaped too. The result is still
 * valid JSON that parses back to the same value.
 */
export function escapeJsonForHtml(value: unknown): string {
  const json = JSON.stringify(value);
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/** The `sha256-<base64>` CSP source of exactly this text. */
export function cspHashOf(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

const NOINDEX = 'noindex, nofollow';

/**
 * Headers of a framed-site response. The frame may be embedded by this
 * origin only: it is the shell's iframe and nothing else.
 */
export function frameHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': NOINDEX,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "frame-ancestors 'self'",
    'Referrer-Policy': 'same-origin',
  };
}

export type CmsDocumentHeaderInput = {
  /** Whether to send a Content-Security-Policy at all. */
  readonly csp: boolean;
  /** `sha256-...` sources for the inline scripts the document carries. */
  readonly scriptHashes?: readonly string[];
  /** `sha256-...` sources for the inline styles the document carries. */
  readonly styleHashes?: readonly string[];
};

/**
 * The policy of the edit shell: only this origin, only the listed inline
 * scripts and styles (by hash, never `unsafe-inline`), no framing by anyone,
 * and forms and base URLs locked down. The one frame the shell embeds is the
 * site itself, so `frame-src` is this origin.
 */
export function buildShellCsp(input: CmsDocumentHeaderInput): string {
  const sources = (hashes: readonly string[] | undefined): string =>
    (hashes ?? []).map((hash) => ` '${hash}'`).join('');
  return [
    "default-src 'self'",
    `script-src 'self'${sources(input.scriptHashes)}`,
    `style-src 'self'${sources(input.styleHashes)}`,
    "img-src 'self' data:",
    "frame-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Headers of an editor-owned document (the shell): never framed, never
 * indexed, no referrer. */
export function cmsDocumentHeaders(
  input: CmsDocumentHeaderInput,
): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': NOINDEX,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...(input.csp ? { 'Content-Security-Policy': buildShellCsp(input) } : {}),
  };
}

export type CmsDocumentInput = {
  readonly title: string;
  /** Trusted markup for the head, after the fixed tags. */
  readonly headHtml?: string;
  /** Trusted markup for the body. */
  readonly bodyHtml: string;
};

/**
 * One complete editor-owned HTML document. The title is escaped here;
 * `headHtml` and `bodyHtml` must already be safe markup (rendered by React or
 * built from escaped values).
 */
export function buildCmsDocument(input: CmsDocumentInput): string {
  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="robots" content="${NOINDEX}">`,
    `<title>${escapeHtml(input.title)}</title>`,
    input.headHtml ?? '',
    '</head><body>',
    input.bodyHtml,
    '</body></html>',
  ].join('');
}
