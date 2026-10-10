/**
 * The login document (`/cms` and the email-link landings): a complete
 * editor-owned HTML page, never the host's. One `plakboek-editor` element
 * whose declarative shadow root holds the chrome stylesheet, the backdrop
 * (the real page in a same-origin iframe, blurred, inert and hidden from
 * assistive technology), the scrim and the card in a native `<dialog>`.
 *
 * Everything is in the server markup, so the first paint already shows blur,
 * scrim and card with no entrance animation. The backdrop is static markup
 * outside the hydrated root, so hydrating the card can never reload it.
 *
 * Link tokens live in the URL of this document. `Referrer-Policy: no-referrer`
 * (from `cmsDocumentHeaders`) keeps them out of every request the page makes,
 * and the token itself is not copied into the markup or the island.
 */
import { renderToString } from 'react-dom/server';
import { LoginApp } from '../chrome/login/login-app.js';
import {
  HOST_TAG,
  ISLAND_ELEMENT_ID,
  LOGIN_ROOT_ID,
  type LoginIsland,
} from '../chrome/island.js';
import { chromeStyleElement, CHROME_STYLE_CSP_HASH } from '../chrome/styles.js';
import {
  hasDevScripts,
  renderEditorScripts,
  type EditorAssets,
} from './assets.js';
import {
  buildCmsDocument,
  cmsDocumentHeaders,
  escapeHtml,
  escapeJsonForHtml,
} from './html-document.js';
import {
  SHELL_HEAD_STYLE,
  SHELL_HEAD_STYLE_CSP_HASH,
} from './shell-document.js';

export type LoginDocumentInput = {
  readonly island: LoginIsland;
  readonly assets: EditorAssets;
  readonly csp: boolean;
};

export type LoginDocument = {
  readonly html: string;
  readonly headers: Record<string, string>;
};

/** The title of every login step: the heading changes, the page does not. */
export const LOGIN_TITLE = 'Sign in · Plakboek';

/** The backdrop: inert, hidden from assistive technology, out of the tab
 * order and blurred by the chrome stylesheet. `next` is attribute-escaped. */
function backdropFrame(next: string): string {
  return `<iframe class="pk-backdrop" src="${escapeHtml(next)}" tabindex="-1" aria-hidden="true" inert></iframe>`;
}

/** Renders the login document: the page and the headers to serve it with. */
export function renderLoginDocument(input: LoginDocumentInput): LoginDocument {
  const { island } = input;
  const card = renderToString(
    <LoginApp
      step={island.step}
      next={island.next}
      {...(island.linkKind === undefined ? {} : { linkKind: island.linkKind })}
    />,
  );
  const host =
    `<${HOST_TAG} data-mode="login">` +
    '<template shadowrootmode="open">' +
    chromeStyleElement() +
    backdropFrame(island.next) +
    `<div id="${LOGIN_ROOT_ID}">${card}</div>` +
    `</template></${HOST_TAG}>`;
  const data = `<script type="application/json" id="${ISLAND_ELEMENT_ID}">${escapeJsonForHtml(island)}</script>`;
  const html = buildCmsDocument({
    title: LOGIN_TITLE,
    headHtml: `<style>${SHELL_HEAD_STYLE}</style>`,
    bodyHtml: host + data + renderEditorScripts(input.assets),
  });
  return {
    html,
    headers: cmsDocumentHeaders({
      csp: input.csp && !hasDevScripts(input.assets),
      styleHashes: [CHROME_STYLE_CSP_HASH, SHELL_HEAD_STYLE_CSP_HASH],
    }),
  };
}
