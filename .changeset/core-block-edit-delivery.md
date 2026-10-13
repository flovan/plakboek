---
'@plakboek/core': minor
'@plakboek/editor': minor
---

Deliver a host's block lifecycle hook modules to the editor and only the editor. The `plakboek()` Vite plugin gains a `blockEdit` option (default `/blocks/**/*.edit.{ts,tsx}`) and a `virtual:plakboek/block-edit` module that the editor's client chunk imports lazily; the client build now fails, naming the chunk and the module, when anything a visitor loads reaches a `*.edit.ts` module or that virtual module. `bootEditor` accepts `{ blockEdit }`, and the shell loads the modules once after hydration, keeping the valid ones and reporting invalid, failing or duplicate modules by file key without breaking the editor. `@plakboek/editor/client` exports the `BootEditorOptions` and `BlockEditLoaders` types.
