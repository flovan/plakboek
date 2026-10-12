/**
 * How the host build hands the editor's client to the server: the plugin
 * emits the editor's client as its own chunk plus a small JSON sidecar, and
 * the server build reads the sidecar into the `EditorAssets` the editor puts
 * in the shell document. Vite deletes its own manifest after the client build,
 * so the sidecar is what carries the hashed chunk URL across the two builds.
 */
import type { EditorAssets } from '@plakboek/editor/server';

/** The name of the editor's client chunk (`assets/plakboek-editor-<hash>.js`). */
export const EDITOR_CHUNK_NAME = 'plakboek-editor';

/** The sidecar the client build writes next to its assets. */
export const EDITOR_SIDECAR = 'plakboek-editor.json';

/** The virtual module the editor chunk is built from. */
export const EDITOR_CLIENT_ID = 'virtual:plakboek/editor-client';

/** Build-output-relative file names: the chunk, what it loads statically and
 * the stylesheets those chunks import. */
export type EditorSidecar = {
  readonly file: string;
  readonly imports: readonly string[];
  readonly css: readonly string[];
};

/** The parts of a Rollup or Rolldown output chunk this module reads. */
export type BundleChunk = {
  readonly type: 'chunk';
  readonly name: string;
  readonly fileName: string;
  readonly isEntry: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly moduleIds: readonly string[];
  readonly viteMetadata?: {
    readonly importedCss?: ReadonlySet<string>;
  };
};

/** A bundle as `generateBundle` receives it: chunks next to assets. */
export type BundleLike = Readonly<
  Record<string, BundleChunk | { readonly type: 'asset' }>
>;

function isChunk(value: BundleLike[string] | undefined): value is BundleChunk {
  return value?.type === 'chunk';
}

/** The editor's entry chunk, or `undefined` when the bundle has none. */
export function findEditorChunk(bundle: BundleLike): BundleChunk | undefined {
  for (const entry of Object.values(bundle)) {
    if (isChunk(entry) && entry.isEntry && entry.name === EDITOR_CHUNK_NAME) {
      return entry;
    }
  }
  return undefined;
}

/**
 * The sidecar for a client bundle: the editor chunk, every chunk it loads
 * statically (transitively, so each can be preloaded) and the stylesheets any
 * of them imports. Dynamic imports are left out on purpose; they load on
 * demand. `undefined` when the bundle holds no editor chunk.
 */
export function buildEditorSidecar(
  bundle: BundleLike,
): EditorSidecar | undefined {
  const entry = findEditorChunk(bundle);
  if (entry === undefined) return undefined;
  const files = new Set<string>();
  const css = new Set<string>();
  const queue = [entry.fileName];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (files.has(file)) continue;
    files.add(file);
    const chunk = bundle[file];
    if (!isChunk(chunk)) continue;
    for (const href of chunk.viteMetadata?.importedCss ?? []) css.add(href);
    queue.push(...chunk.imports);
  }
  files.delete(entry.fileName);
  return { file: entry.fileName, imports: [...files], css: [...css] };
}

/** `base` with exactly one trailing slash. */
function withTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/** The editor's assets for a production build, at the host's public `base`. */
export function editorAssetsFromSidecar(
  sidecar: EditorSidecar,
  base: string,
): EditorAssets {
  const root = withTrailingSlash(base);
  return {
    entry: root + sidecar.file,
    preload: sidecar.imports.map((file) => root + file),
    css: sidecar.css.map((file) => root + file),
  };
}

/**
 * The editor's assets while the dev server runs, in the order the browser
 * must run them (D-29): React Router's HMR runtime preamble, a data-router
 * stub, Vite's client, then the virtual module through Vite's own URL.
 *
 * The edit page hydrates an entry that is not a React Router route, and
 * Fast Refresh needs two things from React Router that a route page gets
 * for free: the preamble (its refresh boundaries throw without it) and a
 * data router to revalidate before it refreshes. The stub answers that call
 * and does nothing. Both are React Router internals, which is why a fixture
 * test pins the behaviour rather than this module's text alone.
 */
export function devEditorAssets(base: string): EditorAssets {
  const root = withTrailingSlash(base);
  return {
    entry: `${root}@id/__x00__${EDITOR_CLIENT_ID}`,
    preload: [],
    css: [],
    devScripts: [
      {
        code: `import "${root}@id/__x00__virtual:react-router/inject-hmr-runtime";`,
      },
      {
        code: 'window.__reactRouterDataRouter ??= { revalidate: async () => {} };',
      },
      { src: `${root}@vite/client` },
    ],
  };
}
