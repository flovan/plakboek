/**
 * The `plakboek()` Vite plugin: the build-time wiring that lets the
 * package's route modules reach the host's configuration without a static
 * import. The virtual module holds server code, so the client environment
 * only ever receives an inert stub.
 *
 * Development (D-22, D-28, D-29): `.env` is loaded into the server process, the
 * dev server refuses to start on an invalid runtime environment, and a change
 * to any server-environment module sends one full page reload. Visitor pages
 * ship no client React, so there is no HMR on the visitor path and no dev
 * cache; the next request re-evaluates the host config and rebuilds the
 * registries.
 *
 * The edit page hydrates chrome only in this release. Editor client modules,
 * and any client-only module in their graph, update through React Fast Refresh
 * with their state kept: the shell loads React Router's refresh preamble and a
 * data-router stub before the editor entry (`devEditorAssets`). A change to a
 * server-environment module (a block, the site document, the config) still
 * sends one full reload, which reloads the edit shell and its frame so the
 * server-rendered page shows the change. The next phase narrows that rule when
 * blocks render on the client.
 */
import { resolve } from 'node:path';
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
  type BundleLike,
  type EditorSidecar,
} from './editor-assets.js';
import { readRuntimeEnv } from './runtime/env.js';

const VIRTUAL_ID = 'virtual:plakboek/host';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const RESOLVED_EDITOR_CLIENT_ID = `\0${EDITOR_CLIENT_ID}`;

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
    'bootEditor();',
  ].join('\n');
}

export function plakboek(options: PlakboekPluginOptions): Plugin {
  let root = process.cwd();
  let base = '/';
  let command: 'serve' | 'build' = 'serve';
  // Written by the client build, read by the server build that follows it in
  // the same process.
  let sidecar: EditorSidecar | undefined;

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
      server.ws.send({ type: 'full-reload' });
      return undefined;
    },
    buildStart() {
      // The editor's client is its own entry chunk, referenced only by the
      // edit shell; nothing a visitor loads imports it.
      if (command !== 'build' || this.environment.name !== 'client') return;
      this.emitFile({
        type: 'chunk',
        id: EDITOR_CLIENT_ID,
        name: EDITOR_CHUNK_NAME,
      });
    },
    generateBundle(_outputOptions, bundle) {
      if (this.environment.name !== 'client') return;
      const output = bundle as unknown as BundleLike;
      // The build-time check of EDIT-14: nothing a visitor loads may reach
      // editor code, however a host's own routes import it.
      const leaks = findEditorLeaks(output);
      if (leaks.length > 0) {
        this.error(
          [
            '[@plakboek/core] Editor code is reachable from a client chunk that visitors load, so it would ship to them:',
            ...leaks.map(
              (leak) => `  ${leak.entry} -> ${leak.chunk}: ${leak.module}`,
            ),
            'Host route modules and the client entry must never import @plakboek/editor; the editor loads only through its own chunk.',
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
      return undefined;
    },
    load(id) {
      if (id === RESOLVED_EDITOR_CLIENT_ID) return editorClientSource();
      if (id !== RESOLVED_ID) return undefined;
      if (this.environment.name === 'client') {
        return [
          'export const config = undefined;',
          'export const site = undefined;',
          'export const edit = undefined;',
          'export const editorAssets = undefined;',
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
      ].join('\n');
    },
  };
}
