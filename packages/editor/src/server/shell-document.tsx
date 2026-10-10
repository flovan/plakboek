/**
 * The edit shell document (`<page>?_edit=1`): a complete editor-owned HTML
 * page, never the host's. Its only content is one `plakboek-editor` element
 * whose declarative shadow root holds the chrome (its stylesheet, the sidebar
 * and the stage with the framed site's iframe), the JSON island the client
 * reads, and the editor's script tags.
 *
 * The chrome is server-rendered inside the shadow root so it paints before any
 * script runs; the client hydrates it from the island without reloading the
 * iframe. Every dynamic value reaches the markup through React's escaping or
 * through `escapeJsonForHtml`.
 */
import { renderToString } from 'react-dom/server';
import { ShellApp } from '../chrome/shell.js';
import {
  HOST_TAG,
  ISLAND_ELEMENT_ID,
  SHELL_ROOT_ID,
  type ShellIsland,
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
  cspHashOf,
  escapeJsonForHtml,
} from './html-document.js';
import type { EditorIdentity } from './identity.js';
import { frameLocation } from './locations.js';

/** Where the Log out form posts. */
export const LOGOUT_PATH = '/cms/logout';

/** The one static style of the shell document: no margin, no scroll, and the
 * stage colour behind the chrome so there is no flash before it paints. */
export const SHELL_HEAD_STYLE =
  'html,body{margin:0;height:100%;overflow:hidden;background:#f4f4f5}@media (prefers-color-scheme:dark){html,body{background:#18181b}}';

/** The CSP source that allows `SHELL_HEAD_STYLE`. */
export const SHELL_HEAD_STYLE_CSP_HASH = cspHashOf(SHELL_HEAD_STYLE);

export type ShellDocumentInput = {
  readonly identity: Pick<EditorIdentity, 'name' | 'email' | 'canEdit'>;
  /** The page without `_edit`. */
  readonly visitorLocation: string;
  readonly assets: EditorAssets;
  readonly csp: boolean;
};

export type ShellDocument = {
  readonly html: string;
  readonly headers: Record<string, string>;
};

/** What the chrome is told about this session: nothing it could grant itself
 * anything with. */
export function buildShellIsland(input: ShellDocumentInput): ShellIsland {
  return {
    kind: 'shell',
    mode: input.identity.canEdit ? 'edit' : 'read-only',
    user: { name: input.identity.name, email: input.identity.email },
    visitorLocation: input.visitorLocation,
    frameUrl: frameLocation(input.visitorLocation),
    logoutPath: LOGOUT_PATH,
  };
}

/** Renders the edit shell: the document and the headers to serve it with. */
export function renderShellDocument(input: ShellDocumentInput): ShellDocument {
  const island = buildShellIsland(input);
  const chrome = renderToString(<ShellApp island={island} hydrated={false} />);
  const host =
    `<${HOST_TAG} data-layout="framed" data-mode="${island.mode}">` +
    '<template shadowrootmode="open">' +
    chromeStyleElement() +
    `<div id="${SHELL_ROOT_ID}" class="pk-shell">${chrome}</div>` +
    `</template></${HOST_TAG}>`;
  const data = `<script type="application/json" id="${ISLAND_ELEMENT_ID}">${escapeJsonForHtml(island)}</script>`;
  const html = buildCmsDocument({
    title: 'Plakboek',
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
