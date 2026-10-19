---
'@plakboek/core': minor
'@plakboek/editor': patch
---

A host now declares one global text theme in `plakboek.config.ts` as `defineConfig({ textTheme: defineTextTheme({ ... }) })`. `defineConfig` registers it before blocks are defined, returns it as `config.textTheme`, refuses anything that is not a `defineTextTheme` result (`INVALID_TEXT_THEME`) and refuses a `rich_text` property whose `narrow` option would widen the theme (`TEXT_THEME_NARROWING_WIDENS`), including inside repeater sub-fields. It also registers the CMS `link` field type, which a host field type with the same key replaces. The `plakboek()` Vite plugin gains a `textTheme` option (default `/text-theme.{ts,tsx}`) that delivers the same module to the editor chunk through `virtual:plakboek/text-theme`; the editor boot accepts it as `BootEditorOptions.textTheme`.
