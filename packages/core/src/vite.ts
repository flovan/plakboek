/**
 * The `plakboek()` Vite plugin: the build-time wiring that lets the
 * package's route modules reach the host's configuration without a static
 * import. The virtual module holds server code, so the client environment
 * only ever receives an inert stub.
 *
 * Development (D-22, D-28): `.env` is loaded into the server process, the dev
 * server refuses to start on an invalid runtime environment, and a change to
 * any server-side module sends one full page reload. Visitor pages ship no
 * client React, so there is no HMR on the visitor path and no dev cache; the
 * next request re-evaluates the host config and rebuilds the registries.
 *
 * Record for Phase 7: the `_edit` route hydrates real React, so it must
 * support React Fast Refresh for host block components while preserving
 * editor state. The blanket full reload below applies to the visitor path
 * only and must be narrowed when that route exists (D-22).
 */
import { resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { readRuntimeEnv } from './runtime/env.js';

const VIRTUAL_ID = 'virtual:plakboek/host';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

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

export function plakboek(options: PlakboekPluginOptions): Plugin {
  let root = process.cwd();
  let command: 'serve' | 'build' = 'serve';
  return {
    name: 'plakboek',
    configResolved(resolved) {
      root = resolved.root;
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
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      if (this.environment.name === 'client') {
        return [
          'export const config = undefined;',
          'export const site = undefined;',
          'export const edit = undefined;',
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
      ].join('\n');
    },
  };
}
