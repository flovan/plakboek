# @plakboek/core

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
