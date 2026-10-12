/**
 * The built editor client the shell loads, described by the host's build and
 * rendered into the shell document as tags.
 */
import { escapeHtml } from './html-document.js';

/** A development-only script: a URL, or inline code (a refresh preamble). */
export type EditorDevScript =
  | { readonly src: string }
  | { readonly code: string };

export type EditorAssets = {
  /** URL of the module that calls `bootEditor()`. */
  readonly entry: string;
  /** URLs of chunks to preload before the entry runs. */
  readonly preload: readonly string[];
  /** URLs of stylesheets the client chunks need. */
  readonly css: readonly string[];
  /** Scripts that run before the entry in development. When present the shell
   * sends no Content-Security-Policy, because their inline code has no
   * stable hash. */
  readonly devScripts?: readonly EditorDevScript[];
};

/** Whether the shell can carry a strict policy: no dev script is present. */
export function hasDevScripts(assets: EditorAssets): boolean {
  return (assets.devScripts?.length ?? 0) > 0;
}

/**
 * The tags for the editor client: module preloads, stylesheets, development
 * scripts in order, then the entry module. Every URL is attribute-escaped.
 */
export function renderEditorScripts(assets: EditorAssets): string {
  const tags: string[] = [];
  for (const href of assets.preload) {
    tags.push(`<link rel="modulepreload" href="${escapeHtml(href)}">`);
  }
  for (const href of assets.css) {
    tags.push(`<link rel="stylesheet" href="${escapeHtml(href)}">`);
  }
  for (const script of assets.devScripts ?? []) {
    if ('src' in script) {
      tags.push(
        `<script type="module" src="${escapeHtml(script.src)}"></script>`,
      );
    } else {
      // Inline development code cannot be allowed to close its own element.
      tags.push(
        `<script type="module">${script.code.replaceAll('</script', '<\\/script')}</script>`,
      );
    }
  }
  tags.push(
    `<script type="module" src="${escapeHtml(assets.entry)}"></script>`,
  );
  return tags.join('');
}
