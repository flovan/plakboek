/**
 * The visitor/edit seam (D-03, D-05, D-10): everything a visitor page carries
 * so that an editor can step from the live site into editing it, and nothing
 * more.
 *
 * - `_edit` is detected on the server by the visitor handler, never trusted
 *   from the client. A request carrying it goes to an injected
 *   `EditEntrypoint`, which lives in a separate module the host composes in
 *   (the editor package writes it). The visitor handler module imports nothing
 *   editor-related, so editor code stays out of the visitor bundle.
 * - The only script a visitor page carries is the toolbar bootstrap below. It
 *   is static, framework-free and inert unless a non-secret flag in
 *   `localStorage` says an editor signed in on this browser. It never fetches,
 *   never verifies a session and never grants anything: all it can do is
 *   navigate to the same URL with `_edit=1`, where the server decides.
 * - Shared caches serve the same bytes to every visitor, so a per-request CSP
 *   nonce is impossible. The bootstrap is therefore constant text, and its
 *   `sha256-...` source is exported for a host's `script-src`.
 */
import { createHash } from 'node:crypto';
import {
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  TOOLBAR_DISMISSED_KEY,
} from './constants.js';

/** What the handler passes an edit entrypoint besides the request. */
export type EditRequestContext = {
  /** The parsed request URL, `_edit` still on it. */
  readonly url: URL;
  /** The same page without `_edit`: where a non-editor is bounced to. */
  readonly visitorLocation: string;
};

/**
 * The editor's entrypoint. It verifies the editor's session on the server and
 * resolves a `Response` for someone who may edit; it resolves `null` for
 * anyone who may not, which the handler turns into a bounce to
 * `visitorLocation`.
 */
export type EditEntrypoint = (
  request: Request,
  context: EditRequestContext,
) => Promise<Response | null>;

/**
 * The location a request goes back to without `_edit`: the pathname with runs
 * of `/` collapsed to one, plus the query string minus every `_edit`
 * parameter (omitted when nothing is left). Same-origin and relative by
 * construction, so it can never be protocol-relative.
 */
export function editBounceLocation(url: URL): string {
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((segment) => {
      if (segment === '') return false;
      return new URLSearchParams(segment).keys().next().value !== EDIT_PARAM;
    });
  return kept.length === 0 ? pathname : `${pathname}?${kept.join('&')}`;
}

const TOOLBAR_STYLES =
  ':host{all:initial}div{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:4px;font:600 14px system-ui,sans-serif}button{font:inherit;border:0;border-radius:999px;padding:8px 14px;background:#111;color:#fff;cursor:pointer}button+button{padding:8px 10px;background:#444}';

/**
 * The bootstrap source. Everything runs inside one `try`: a browser without
 * storage access (privacy mode) or any other failure leaves the page exactly
 * as it was. Elements are built with `createElement` and `textContent` only,
 * and the pill lives in a closed shadow root so neither the site's CSS reaches
 * it nor its styles leak out.
 */
const BOOTSTRAP_SOURCE = [
  '(function(){try{',
  `var E=${JSON.stringify(EDITOR_FLAG_KEY)},D=${JSON.stringify(TOOLBAR_DISMISSED_KEY)},P=${JSON.stringify(EDIT_PARAM)};`,
  'var ls=localStorage;',
  'if(ls.getItem(E)!=="1"||ls.getItem(D)==="1")return;',
  'if(new URL(location.href).searchParams.has(P))return;',
  'var h=document.createElement("plakboek-toolbar");',
  'var r=h.attachShadow({mode:"closed"});',
  'var s=document.createElement("style");',
  `s.textContent=${JSON.stringify(TOOLBAR_STYLES)};`,
  'var w=document.createElement("div");',
  'var b=document.createElement("button");',
  'b.type="button";b.textContent="Edit";',
  'b.addEventListener("click",function(){',
  'var n=new URL(location.href);n.searchParams.set(P,"1");',
  'location.assign(n.pathname+n.search)});',
  'var x=document.createElement("button");',
  'x.type="button";x.textContent="\\u00d7";x.setAttribute("aria-label","Dismiss");',
  'x.addEventListener("click",function(){',
  'try{ls.setItem(D,"1")}catch(e){}',
  'h.remove()});',
  'w.appendChild(b);w.appendChild(x);r.appendChild(s);r.appendChild(w);',
  'document.body.appendChild(h);',
  '}catch(e){}})();',
].join('');

const BOOTSTRAP_HTML = `<script>${BOOTSTRAP_SOURCE}</script>`;

/**
 * The `sha256-<base64>` of exactly the script's text, ready for a host's
 * `script-src 'sha256-...'` directive. Computed once at module load.
 */
export const TOOLBAR_BOOTSTRAP_CSP_HASH = `sha256-${createHash('sha256')
  .update(BOOTSTRAP_SOURCE, 'utf8')
  .digest('base64')}`;

/**
 * The one inline script every visitor page carries: the same string on every
 * call. It does nothing unless the editor flag is set in `localStorage` and
 * the toolbar was not dismissed; then it shows an Edit pill that navigates to
 * the same URL with `_edit=1`.
 */
export function renderToolbarBootstrap(): string {
  return BOOTSTRAP_HTML;
}
