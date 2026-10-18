# @plakboek/core

## 0.7.0

### Minor Changes

- [#22](https://github.com/flovan/plakboek/pull/22) [`c721347`](https://github.com/flovan/plakboek/commit/c721347d4e94e6f8a20a18e99c09329970a57128) Thanks [@flovan](https://github.com/flovan)! - Deliver a host's block lifecycle hook modules to the editor and only the editor. The `plakboek()` Vite plugin gains a `blockEdit` option (default `/blocks/**/*.edit.{ts,tsx}`) and a `virtual:plakboek/block-edit` module that the editor's client chunk imports lazily; the client build now fails, naming the chunk and the module, when anything a visitor loads reaches a `*.edit.ts` module or that virtual module. `bootEditor` accepts `{ blockEdit }`, and the shell loads the modules once after hydration, keeping the valid ones and reporting invalid, failing or duplicate modules by file key without breaking the editor. `@plakboek/editor/client` exports the `BootEditorOptions` and `BlockEditLoaders` types.

- [#22](https://github.com/flovan/plakboek/pull/22) [`9263a62`](https://github.com/flovan/plakboek/commit/9263a624667b6ab53f0dffa6f04f6cd279fcbfc9) Thanks [@flovan](https://github.com/flovan)! - Every installation now registers the CMS-owned `column` block after the host's blocks, and a host block with the key or kind `column` is refused when the config is evaluated. Seed sections may stay flat: bootstrap wraps their blocks in one column. `defineConfig` accepts `columnPresets` to narrow or extend the column ratios. The starter section renders `Columns` around its children, sets `--plakboek-column-gap` and stacks columns below 640px of container width.

- [#22](https://github.com/flovan/plakboek/pull/22) [`c7a86ea`](https://github.com/flovan/plakboek/commit/c7a86ea8c91764049536cc4c2a4bf2010e6046fa) Thanks [@flovan](https://github.com/flovan)! - Serve the editor's JSON API from every host under `/cms/api/*`, a resource route placed before the `/cms/*` pages route. Every answer carries `X-Robots-Tag: noindex, nofollow`, errors included, and the editor's server code loads only when the first API request arrives. A host process now also upgrades stored page trees that predate columns to the column shape in the background after it starts, without delaying any request.

- [#22](https://github.com/flovan/plakboek/pull/22) [`ea4404b`](https://github.com/flovan/plakboek/commit/ea4404beec26a7f0de0e0818a11f469e601b120a) Thanks [@flovan](https://github.com/flovan)! - Editing a block component under `pnpm dev` now swaps just that block instead of reloading the page. The `plakboek()` Vite plugin tells a block change (a module the config reaches that the site document does not) from every other server change and sends the custom `plakboek:blocks-changed` event for it; changes to the config, the site document, route modules and anything outside the config's imports still reload the page. A small dev client, loaded on visitor pages and in the edit frame, fetches the page again and replaces the blocks whose markup changed, then runs their `rendered` hook; in the edit frame the editor's hooks runtime runs it, so the edit shell, the selection and the frame's scroll position stay. Visitor pages carry block markers and the dev client only under the dev server, never in a production response.

### Patch Changes

- [#22](https://github.com/flovan/plakboek/pull/22) [`72f5e35`](https://github.com/flovan/plakboek/commit/72f5e354d97bd45611feb091e9495a45abf10b84) Thanks [@flovan](https://github.com/flovan)! - Document how to write blocks for the editor in the core README: rendering `Columns` in sections, spreading `{...edit}` on one root element, `layout.fill` and `starterChildren`, items as child blocks, `*.edit.ts` hook modules and the `blockEdit` plugin option, binding scripts by delegation or from `rendered`, and the limit on window-capture click listeners.

- [#22](https://github.com/flovan/plakboek/pull/22) [`695b21a`](https://github.com/flovan/plakboek/commit/695b21ab89afa73224bb229639f1f483f5892b42) Thanks [@flovan](https://github.com/flovan)! - The client build's check that keeps editor code away from visitors now takes the block hook modules from what the `blockEdit` glob matched, instead of treating every host file named `*.edit.ts` or `*.edit.tsx` as editor code. A host route such as `profile.edit.tsx` no longer fails the build, and a hook module picked up by a custom `blockEdit` glob under any name is still caught when a visitor chunk imports it.

- Updated dependencies [[`c721347`](https://github.com/flovan/plakboek/commit/c721347d4e94e6f8a20a18e99c09329970a57128), [`babfd25`](https://github.com/flovan/plakboek/commit/babfd255ea45c81587fb87d1d3ca92f6b51d07e2), [`ea4404b`](https://github.com/flovan/plakboek/commit/ea4404beec26a7f0de0e0818a11f469e601b120a), [`3e675f7`](https://github.com/flovan/plakboek/commit/3e675f75b063a81b7be93bb7b62fe5817b375fcf), [`ad630f2`](https://github.com/flovan/plakboek/commit/ad630f2235b056b3b73f33bef268e49ef67a7bca), [`c58378c`](https://github.com/flovan/plakboek/commit/c58378c9c12a63c63b2ffcaa1ef278c8c6dc910b), [`769b119`](https://github.com/flovan/plakboek/commit/769b119aa4d0672beffbfe34eb8359d27fe29c06), [`8bb4a64`](https://github.com/flovan/plakboek/commit/8bb4a64319313d032c9b5f1f5eab3640444b6cc0), [`ca69d4f`](https://github.com/flovan/plakboek/commit/ca69d4fcb3f16b370aafa73ddde6cb17888c15eb), [`708a8bf`](https://github.com/flovan/plakboek/commit/708a8bf94dc07c4141049bff6f7765606e03dfc7), [`70b7c9d`](https://github.com/flovan/plakboek/commit/70b7c9d1eda4ddc3502dcccf59c597d25173f460), [`1ca3741`](https://github.com/flovan/plakboek/commit/1ca3741a9080eaf4c0843b7887b811ca648d6d13), [`0be6241`](https://github.com/flovan/plakboek/commit/0be62411c491fd073df9f023b93e8a18afa38a92), [`415fe6b`](https://github.com/flovan/plakboek/commit/415fe6b9a45fb87c635f86ccdca426208c498b9a), [`3a569fb`](https://github.com/flovan/plakboek/commit/3a569fb91a66e1dd4f64446dc2ce7966725d7b06), [`3741f71`](https://github.com/flovan/plakboek/commit/3741f7123ef7e3d395695b0ba62e9fca7240c51e), [`b10a184`](https://github.com/flovan/plakboek/commit/b10a1841e85183c235657c62317af284cbbfb8b8), [`be2bd42`](https://github.com/flovan/plakboek/commit/be2bd42ee151d85048441909ee49a2bb1e707129), [`c534649`](https://github.com/flovan/plakboek/commit/c5346496f38da9ed6416ee3d7928e6924ae04fac), [`128cd5b`](https://github.com/flovan/plakboek/commit/128cd5bbf974fd6d8dedd23aba0254cdc6f6e293), [`ed69676`](https://github.com/flovan/plakboek/commit/ed6967633a52613c363ab227dc396eae7ecd9cdb), [`ff07eab`](https://github.com/flovan/plakboek/commit/ff07eab1f28ab1f1554538d4e6deadb96bdb68c1), [`46b1f42`](https://github.com/flovan/plakboek/commit/46b1f421d731aacabd70efba7ffdb31147049b46), [`4826b5e`](https://github.com/flovan/plakboek/commit/4826b5eb5e237c149761499e87465a4f9c88e84d), [`2e24024`](https://github.com/flovan/plakboek/commit/2e24024daf1ed40c2f5fb3be955a69fc7a5fabcb), [`679d143`](https://github.com/flovan/plakboek/commit/679d143b3ae393141721f7641f10a74443024fdf), [`58d4b90`](https://github.com/flovan/plakboek/commit/58d4b9042f843fd92543cc4775e897774820889d), [`93226b4`](https://github.com/flovan/plakboek/commit/93226b4b99bfe217130e05efacd94eb3a956e928), [`c352099`](https://github.com/flovan/plakboek/commit/c352099e3b6269c9b4514a2a3a3185a0d0d92736), [`03b865c`](https://github.com/flovan/plakboek/commit/03b865cd39b6ffe49ba10ec25c4a32047e42940e), [`c298afe`](https://github.com/flovan/plakboek/commit/c298afed08f9d64f27eca97576a9b3803245ff7f), [`bb3f473`](https://github.com/flovan/plakboek/commit/bb3f473e0547ff1760f524eeb51ca4204d05fd80), [`23bc841`](https://github.com/flovan/plakboek/commit/23bc841143b5bca5816378c183337116a8993bae), [`2f2f419`](https://github.com/flovan/plakboek/commit/2f2f419ab381404ab4b7b2a7a7af8e30ac4fd3ed), [`1afbaa9`](https://github.com/flovan/plakboek/commit/1afbaa93bfdeba7e8d16a9026eaa9c1abba1ba25), [`cf42768`](https://github.com/flovan/plakboek/commit/cf4276815e5497f92b6f7412418a801386a1eec4), [`687b124`](https://github.com/flovan/plakboek/commit/687b1246c68c014329a7424b43a3e18399732b10), [`f245a23`](https://github.com/flovan/plakboek/commit/f245a235709cb71087f02f6209e0822433ac33b6)]:
  - @plakboek/editor@0.7.0
  - @plakboek/db@0.7.0
  - @plakboek/render@0.7.0
  - @plakboek/pages@0.7.0
  - @plakboek/auth@0.7.0
  - @plakboek/content@0.7.0
  - @plakboek/cache@0.7.0
  - @plakboek/permissions@0.7.0

## 0.6.0

### Minor Changes

- [#20](https://github.com/flovan/plakboek/pull/20) [`f1f3c8b`](https://github.com/flovan/plakboek/commit/f1f3c8b7dcf8eb7b86d1e8765d83d84417d5e989) Thanks [@flovan](https://github.com/flovan)! - Serves the admin entry. `cmsRoutes()` now includes `/cms` and `/cms/*` (the login page and its email-link landings, with the host's own 404 for anything else, never a visitor page), `POST /cms/logout` and a default `/robots.txt` that disallows `/cms`. Logout ends the session on the server, answers only POST, accepts only requests from this site's own pages, reads at most 2 KB, answers 500 instead of a redirect when the sign-out fails, and otherwise redirects to a sanitised `next` without `_edit`. Every answer under `/cms`, including health, setup, logout, the 404 and an error from a failing runtime, now carries `X-Robots-Tag: noindex, nofollow`, set by the route modules so it also holds under `react-router dev`. A host's own `public/robots.txt` is served instead of the default. When the host runtime is first built it reports pages that already sit at a reserved address (`cms` or `api` as the first segment) through the pages hook, keeping them as they are. New optional `PLAKBOEK_TRUSTED_PROXIES` and `PLAKBOEK_CLIENT_IP_HEADERS` variables tell the sign-in and password-link limiter how to find the client behind a reverse proxy.

- [#20](https://github.com/flovan/plakboek/pull/20) [`89e50ce`](https://github.com/flovan/plakboek/commit/89e50ceb2e6fa50628e687dc4a5327fdddedec50) Thanks [@flovan](https://github.com/flovan)! - Every host now gets the real editor without configuration. The runtime builds `createEditEntrypoint` from `@plakboek/editor/server` on the first `_edit` request, from its own authentication, permissions, database, page configuration and site document; the `edit` option of the `plakboek()` Vite plugin still overrides it. The plugin emits the editor's client as its own chunk, `assets/plakboek-editor-<hash>.js`, with a `plakboek-editor.json` sidecar the server build reads, so only the edit shell references it. The build now fails, naming every `entry -> chunk: module` path, when editor code is reachable from the client entry or any route chunk, so it can never ship to a visitor. Each reported path names the fragment that matched (an editor path or `node_modules/@tiptap`, `@dnd-kit` or `prosemirror-`), and the build also fails when the editor chunk is missing from the client output, so the check never passes on nothing. Host route modules must not import `@plakboek/editor`. A runtime built without the plugin's editor assets answers `_edit` requests with the 500 page and reports `EditorAssetsMissingError`.

### Patch Changes

- Updated dependencies [[`8867be6`](https://github.com/flovan/plakboek/commit/8867be6314a74735ee143c8e5034692510faf67b), [`f1f3c8b`](https://github.com/flovan/plakboek/commit/f1f3c8b7dcf8eb7b86d1e8765d83d84417d5e989), [`0bb4052`](https://github.com/flovan/plakboek/commit/0bb40520d7cecc4f391d6d69b7f7c6ff73a5605a), [`2dca895`](https://github.com/flovan/plakboek/commit/2dca895f313a437b717f721f3b625d48db473baf), [`47cf85f`](https://github.com/flovan/plakboek/commit/47cf85f6cf7d0a7589d2876d8cfc96da655d214a), [`e97202b`](https://github.com/flovan/plakboek/commit/e97202bbac0cfa67e1f83d65c2261b0b53b40e53), [`26e4e6d`](https://github.com/flovan/plakboek/commit/26e4e6d261ee3479aae9e7f0f6f0899f62fb4445), [`9d589ed`](https://github.com/flovan/plakboek/commit/9d589eda746b0666d0e43915df57c6fc4d4aef18), [`c9938cd`](https://github.com/flovan/plakboek/commit/c9938cd3bc676d005d3083af49df8c6869022196), [`ebb81f2`](https://github.com/flovan/plakboek/commit/ebb81f2682f2e3a097435166dead985050f36636), [`41afc1e`](https://github.com/flovan/plakboek/commit/41afc1e6e60582252ac0e47902479cc0eaff1654), [`93b8eae`](https://github.com/flovan/plakboek/commit/93b8eaeefb31f4e936fe9db02f874799a59a40da)]:
  - @plakboek/auth@0.6.0
  - @plakboek/editor@0.6.0
  - @plakboek/pages@0.6.0
  - @plakboek/render@0.6.0
  - @plakboek/content@0.6.0
  - @plakboek/cache@0.6.0
  - @plakboek/db@0.6.0
  - @plakboek/permissions@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @plakboek/auth@0.5.1
  - @plakboek/cache@0.5.1
  - @plakboek/content@0.5.1
  - @plakboek/db@0.5.1
  - @plakboek/pages@0.5.1
  - @plakboek/permissions@0.5.1
  - @plakboek/render@0.5.1

## 0.5.0

### Minor Changes

- [#15](https://github.com/flovan/plakboek/pull/15) [`1f590c9`](https://github.com/flovan/plakboek/commit/1f590c99bf740341460636e87dae549925a43e4f) Thanks [@flovan](https://github.com/flovan)! - First release of `@plakboek/core`, the host integration package. A host app built with React Router 8 spreads `cmsRoutes()` into its own route config, adds the `plakboek()` Vite plugin and starts `createServer()`: published pages are served at `/` and every other path through the visitor handler, next to the host's own routes. The package root exports `defineBlock` and the host-facing types and is safe to import from a client bundle.

### Patch Changes

- Updated dependencies [[`82a38b2`](https://github.com/flovan/plakboek/commit/82a38b24f8e5ccc59650b6986704d30d654c795a), [`acec821`](https://github.com/flovan/plakboek/commit/acec8217e77250d4e984becd7f210d77a4e04de9)]:
  - @plakboek/db@0.5.0
  - @plakboek/render@0.5.0
  - @plakboek/auth@0.5.0
  - @plakboek/content@0.5.0
  - @plakboek/pages@0.5.0
  - @plakboek/cache@0.5.0
  - @plakboek/permissions@0.5.0
