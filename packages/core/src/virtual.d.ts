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
  export const editorAssets:
    | import('@plakboek/editor/server').EditorAssets
    | undefined;
  export const devMode: boolean;
}

/**
 * The host's text theme module, delivered to the editor chunk only: the
 * default export of the first file the plugin's `textTheme` glob matched, or
 * `undefined` when none matched. Checked with `isTextThemeDefinition` before
 * use.
 */
declare module 'virtual:plakboek/text-theme' {
  export const textTheme: unknown;
}
