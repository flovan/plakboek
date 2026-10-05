/**
 * The `plakboek()` Vite plugin: the build-time wiring that lets the
 * package's route modules reach the host's configuration without a static
 * import. The virtual module holds server code, so the client environment
 * only ever receives an inert stub.
 */
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

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
  return {
    name: 'plakboek',
    configResolved(resolved) {
      root = resolved.root;
    },
    config() {
      return { ssr: { noExternal: ['@plakboek/core'] } };
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
