/**
 * The `plakboek()` Vite plugin: the build-time wiring that lets the
 * package's route modules reach the host's configuration without a static
 * import. The virtual module holds server code, so the client environment
 * only ever receives an inert stub.
 *
 * Development (D-22, D-28, D-29): `.env` is loaded into the server process, the
 * dev server refuses to start on an invalid runtime environment, and a change
 * to a server-environment module is told to the browser in one of two ways. A
 * change to a block component (a module the config reaches that the site
 * document does not) sends the custom event `plakboek:blocks-changed`; the dev
 * swap module, loaded on visitor pages and in the edit frame, then fetches the
 * page again and replaces just the blocks whose markup changed, so the edit
 * shell, its selection and the frame's scroll position stay. Any other change
 * (the config, the site, a route module, anything outside the config's
 * imports) sends a full reload. Visitor pages ship no client React and there
 * is no dev cache; the next request re-evaluates the host config and rebuilds
 * the registries.
 *
 * The edit page hydrates chrome only in this release. Editor client modules,
 * and any client-only module in their graph, update through React Fast Refresh
 * with their state kept: the shell loads React Router's refresh preamble and a
 * data-router stub before the editor entry (`devEditorAssets`).
 */
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { findEditorLeaks } from './editor-closure.js';
import {
  buildEditorSidecar,
  devEditorAssets,
  EDITOR_CHUNK_NAME,
  EDITOR_CLIENT_ID,
  EDITOR_SIDECAR,
  editorAssetsFromSidecar,
  findEditorChunk,
  type BundleLike,
  type EditorSidecar,
} from './editor-assets.js';
import { readRuntimeEnv } from './runtime/env.js';

const VIRTUAL_ID = 'virtual:plakboek/host';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const RESOLVED_EDITOR_CLIENT_ID = `\0${EDITOR_CLIENT_ID}`;
const BLOCK_EDIT_ID = 'virtual:plakboek/block-edit';
const RESOLVED_BLOCK_EDIT_ID = `\0${BLOCK_EDIT_ID}`;
const DEV_SWAP_ID = 'virtual:plakboek/dev-swap';
const RESOLVED_DEV_SWAP_ID = `\0${DEV_SWAP_ID}`;
/** The custom HMR event a block change sends (D-29). */
const BLOCKS_CHANGED_EVENT = 'plakboek:blocks-changed';
/** Where block edit modules are found when the host sets no `blockEdit`. */
const DEFAULT_BLOCK_EDIT_GLOB = '/blocks/**/*.edit.{ts,tsx}';

export type PlakboekPluginOptions = {
  /** Path to the module whose default export is the `defineConfig` result. */
  readonly config: string;
  /** Path to the host's site module. */
  readonly site: string;
  /**
   * Path to a module exporting `edit`, the editor's entrypoint. Requests
   * carrying `_edit` are dispatched to it by the visitor handler; without it
   * every `_edit` request is bounced to the plain page.
   */
  readonly edit?: string;
  /**
   * Where the host's block lifecycle hook modules are found: one Vite glob or
   * a list of them, root-relative (a leading `/` is the project root).
   * Defaults to `/blocks/**\/*.edit.{ts,tsx}`.
   *
   * A module named `*.edit.ts` or `*.edit.tsx` default-exports
   * `defineBlockEdit({ blockType, hooks })`. These modules are loaded lazily
   * into the editor's own chunk through `virtual:plakboek/block-edit` and
   * nowhere else: the client build fails, naming the chunk and the module, if
   * anything a visitor loads (a route module, the client entry, a block
   * definition) imports one. Block definitions therefore stay hook-free.
   */
  readonly blockEdit?: string | readonly string[];
};

/**
 * The module the editor chunk is built from. The editor client is resolved
 * from this package's own location, so a host under pnpm's isolated layout
 * needs no direct dependency on the editor.
 */
function editorClientSource(): string {
  const entry = fileURLToPath(import.meta.resolve('@plakboek/editor/client'));
  return [
    `import { bootEditor } from ${JSON.stringify(entry)};`,
    `import { blockEditModules } from ${JSON.stringify(BLOCK_EDIT_ID)};`,
    'bootEditor(document, { blockEdit: blockEditModules });',
  ].join('\n');
}

/**
 * The dev swap module, loaded by the development server on every HTML page
 * after Vite's client. It exists only under `serve`. On a visitor page and in
 * the edit frame it swaps changed blocks when the plugin announces a block
 * change; the edit shell itself holds no blocks and is left alone. In the
 * frame the editor's own hooks runtime calls `rendered`; on a visitor page
 * this module does, with empty props and the interact mode.
 *
 * The attribute names are the renderer's `EDIT_ATTRIBUTE.block` and `.type`;
 * a unit test keeps them equal.
 */
function devSwapSource(): string {
  const hot = fileURLToPath(import.meta.resolve('@plakboek/editor/hot'));
  return `
import { createDevBlockSwap } from ${JSON.stringify(hot)};

const BLOCK = 'data-pk-block';
const TYPE = 'data-pk-type';
const mode = new URLSearchParams(location.search).get('_edit');

if (import.meta.hot && (mode === null || mode === 'frame')) {
  const swapper = createDevBlockSwap({ document, url: location.href });
  swapper.ready.catch(() => undefined);

  import.meta.hot.on(${JSON.stringify(BLOCKS_CHANGED_EVENT)}, async () => {
    await swapper.swap();
  });

  if (mode === null) {
    let loaded;
    const hooksByType = () =>
      (loaded ??= import(${JSON.stringify(BLOCK_EDIT_ID)}).then(async (module) => {
        const hooks = new Map();
        const modules = await Promise.all(
          Object.values(module.blockEditModules).map((load) => load().catch(() => undefined)),
        );
        for (const found of modules) {
          const value = found?.default;
          if (value && typeof value.blockType === 'string' && value.hooks && !hooks.has(value.blockType)) {
            hooks.set(value.blockType, value.hooks);
          }
        }
        return hooks;
      }));

    document.addEventListener('plakboek:blocks-swapped', async (event) => {
      const hooks = await hooksByType();
      const elements = new Set();
      for (const id of event.detail?.ids ?? []) {
        const root = document.querySelector('[' + BLOCK + '="' + CSS.escape(id) + '"]');
        if (!root) continue;
        elements.add(root);
        for (const nested of root.querySelectorAll('[' + BLOCK + ']')) elements.add(nested);
      }
      for (const element of elements) {
        const blockType = element.getAttribute(TYPE);
        const rendered = blockType === null ? undefined : hooks.get(blockType)?.rendered;
        if (!rendered) continue;
        try {
          rendered({
            id: element.getAttribute(BLOCK),
            blockType,
            element,
            document,
            window,
            props: {},
            mode: 'interact',
          });
        } catch (error) {
          console.warn('[@plakboek/core] dev rendered hook failed: ' + (error?.name ?? 'an error'));
        }
      }
    });
  }
}
`;
}

/** The structural slice of a Vite module node the classification reads. */
type ModuleLike = {
  readonly file?: string | null;
  readonly importers: ReadonlySet<ModuleLike>;
};

/** The module and everything that imports it, directly or not. */
function importerClosure(start: ModuleLike): Set<ModuleLike> {
  const seen = new Set<ModuleLike>([start]);
  const queue = [start];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const importer of next.importers) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return seen;
}

/**
 * Whether a server-side change touched only block code (D-29): none of the
 * changed modules is the config, the site or the edit module, none is a
 * dependency package, each is imported (however indirectly) by the config,
 * and none is imported by the site document. Anything else needs a reload.
 */
function isBlockChange(
  modules: readonly ModuleLike[],
  files: {
    readonly config: string;
    readonly site: string;
    readonly edit?: string;
  },
): boolean {
  const owns = (node: ModuleLike, file: string | undefined) =>
    file !== undefined && node.file === file;
  return modules.every((changed) => {
    const file = changed.file;
    if (file === undefined || file === null) return false;
    if (file.split(sep).includes('node_modules')) return false;
    if (
      owns(changed, files.config) ||
      owns(changed, files.site) ||
      owns(changed, files.edit)
    ) {
      return false;
    }
    const closure = [...importerClosure(changed)];
    return (
      closure.some((node) => owns(node, files.config)) &&
      !closure.some((node) => owns(node, files.site))
    );
  });
}

/**
 * The block-edit module: one lazy import per matching file, keyed by its
 * root-relative path. Only the editor client imports it.
 */
function blockEditSource(option: PlakboekPluginOptions['blockEdit']): string {
  const patterns =
    option === undefined
      ? [DEFAULT_BLOCK_EDIT_GLOB]
      : typeof option === 'string'
        ? [option]
        : [...option];
  return `export const blockEditModules = import.meta.glob(${JSON.stringify(patterns)});`;
}

export function plakboek(options: PlakboekPluginOptions): Plugin {
  let root = process.cwd();
  let base = '/';
  let command: 'serve' | 'build' = 'serve';
  // Written by the client build, read by the server build that follows it in
  // the same process.
  let sidecar: EditorSidecar | undefined;
  // Whether this build asked for the editor chunk, so its absence from the
  // finished bundle is a failure rather than a build without an editor.
  let editorChunkRequested = false;

  function serverEditorAssets(): string {
    if (command === 'serve') return JSON.stringify(devEditorAssets(base));
    if (sidecar === undefined) {
      throw new Error(
        `[@plakboek/core] The server build ran before the client build produced ${EDITOR_SIDECAR}, so the editor's client chunk is unknown. Build with \`react-router build\`, which builds the client first.`,
      );
    }
    return JSON.stringify(editorAssetsFromSidecar(sidecar, base));
  }

  return {
    name: 'plakboek',
    configResolved(resolved) {
      root = resolved.root;
      base = resolved.base;
    },
    config(userConfig, env) {
      command = env.command;
      if (env.command === 'serve') {
        // Server side only: Vite still exposes nothing but `VITE_*` to client
        // code. Variables already set in the process win over the file.
        const fileRoot = resolve(userConfig.root ?? process.cwd());
        for (const [key, value] of Object.entries(
          loadEnv(env.mode, fileRoot, ''),
        )) {
          if (process.env[key] === undefined) process.env[key] = value;
        }
      }
      return { ssr: { noExternal: ['@plakboek/core'] } };
    },
    configureServer() {
      // Same validation as the production server, no fallback: a missing
      // secret aborts `react-router dev` with the generation command. A build
      // never needs runtime secrets.
      if (command === 'serve') readRuntimeEnv(process.env);
    },
    hotUpdate({ modules, server }) {
      if (this.environment.name !== 'ssr' || modules.length === 0) {
        return undefined;
      }
      const files = {
        config: resolve(root, options.config),
        site: resolve(root, options.site),
        ...(options.edit === undefined
          ? {}
          : { edit: resolve(root, options.edit) }),
      };
      if (isBlockChange(modules, files)) {
        server.ws.send({
          type: 'custom',
          event: BLOCKS_CHANGED_EVENT,
          data: {
            files: modules.flatMap((module) =>
              module.file === null || module.file === undefined
                ? []
                : [relative(root, module.file)],
            ),
          },
        });
      } else {
        server.ws.send({ type: 'full-reload' });
      }
      return undefined;
    },
    buildStart() {
      // The editor's client is its own entry chunk, referenced only by the
      // edit shell; nothing a visitor loads imports it.
      if (command !== 'build' || this.environment.name !== 'client') return;
      editorChunkRequested = true;
      this.emitFile({
        type: 'chunk',
        id: EDITOR_CLIENT_ID,
        name: EDITOR_CHUNK_NAME,
      });
    },
    generateBundle(_outputOptions, bundle) {
      if (this.environment.name !== 'client') return;
      const output = bundle as unknown as BundleLike;
      // The check below starts from the editor's chunk. If the build asked
      // for it and it is not there, the check would pass having looked at
      // nothing, so the build fails instead.
      if (editorChunkRequested && findEditorChunk(output) === undefined) {
        this.error(
          "[@plakboek/core] The client build has no editor chunk, so the check that keeps editor code away from visitors cannot run. Check that no other plugin renames or drops the editor's entry.",
        );
      }
      // The build-time check of EDIT-14: nothing a visitor loads may reach
      // editor code, however a host's own routes import it.
      // The hook modules are the ones the host's `blockEdit` glob matched,
      // which the block-edit module imports lazily.
      const leaks = findEditorLeaks(output, {
        blockEditModules:
          this.getModuleInfo(RESOLVED_BLOCK_EDIT_ID)?.dynamicallyImportedIds ??
          [],
      });
      if (leaks.length > 0) {
        this.error(
          [
            '[@plakboek/core] Editor code is reachable from a client chunk that visitors load, so it would ship to them:',
            ...leaks.map(
              (leak) =>
                `  ${leak.entry} -> ${leak.chunk}: ${leak.module} (matched "${leak.match}")`,
            ),
            'Host route modules and the client entry must never import @plakboek/editor, a block edit module (a file the `blockEdit` glob matches, `*.edit.ts` and `*.edit.tsx` by default) or a library only the editor uses (@tiptap, @dnd-kit, prosemirror); the editor loads only through its own chunk.',
          ].join('\n'),
        );
      }
      const found = buildEditorSidecar(output);
      if (found === undefined) return;
      sidecar = found;
      this.emitFile({
        type: 'asset',
        fileName: EDITOR_SIDECAR,
        source: JSON.stringify(found),
      });
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id === EDITOR_CLIENT_ID || id === RESOLVED_EDITOR_CLIENT_ID) {
        return RESOLVED_EDITOR_CLIENT_ID;
      }
      if (id === BLOCK_EDIT_ID || id === RESOLVED_BLOCK_EDIT_ID) {
        return RESOLVED_BLOCK_EDIT_ID;
      }
      if (id === DEV_SWAP_ID || id === RESOLVED_DEV_SWAP_ID) {
        return RESOLVED_DEV_SWAP_ID;
      }
      return undefined;
    },
    load(id) {
      if (id === RESOLVED_EDITOR_CLIENT_ID) return editorClientSource();
      if (id === RESOLVED_BLOCK_EDIT_ID)
        return blockEditSource(options.blockEdit);
      if (id === RESOLVED_DEV_SWAP_ID) {
        return command === 'serve' ? devSwapSource() : 'export {};';
      }
      if (id !== RESOLVED_ID) return undefined;
      if (this.environment.name === 'client') {
        return [
          'export const config = undefined;',
          'export const site = undefined;',
          'export const edit = undefined;',
          'export const editorAssets = undefined;',
          'export const devMode = false;',
        ].join('\n');
      }
      const configPath = JSON.stringify(resolve(root, options.config));
      const sitePath = JSON.stringify(resolve(root, options.site));
      return [
        `export { default as config } from ${configPath};`,
        `export * as site from ${sitePath};`,
        options.edit === undefined
          ? 'export const edit = undefined;'
          : `export { edit } from ${JSON.stringify(resolve(root, options.edit))};`,
        `export const editorAssets = ${serverEditorAssets()};`,
        `export const devMode = ${String(command === 'serve')};`,
      ].join('\n');
    },
  };
}
