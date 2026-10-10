---
'@plakboek/core': minor
---

Every host now gets the real editor without configuration. The runtime builds `createEditEntrypoint` from `@plakboek/editor/server` on the first `_edit` request, from its own authentication, permissions, database, page configuration and site document; the `edit` option of the `plakboek()` Vite plugin still overrides it. The plugin emits the editor's client as its own chunk, `assets/plakboek-editor-<hash>.js`, with a `plakboek-editor.json` sidecar the server build reads, so only the edit shell references it. The build now fails, naming every `entry -> chunk: module` path, when editor code is reachable from the client entry or any route chunk, so it can never ship to a visitor. Host route modules must not import `@plakboek/editor`. A runtime built without the plugin's editor assets answers `_edit` requests with the 500 page and reports `EditorAssetsMissingError`.
