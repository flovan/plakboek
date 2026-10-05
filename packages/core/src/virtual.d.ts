/**
 * The module the `plakboek()` Vite plugin generates. Only
 * `runtime/host.ts` imports it; on the client it is an inert stub.
 */
declare module 'virtual:plakboek/host' {
  export const config: import('./types.js').PlakboekConfig;
  export const site: import('./types.js').SiteModule | undefined;
  export const edit:
    | import('@plakboek/render/server').EditEntrypoint
    | undefined;
}
