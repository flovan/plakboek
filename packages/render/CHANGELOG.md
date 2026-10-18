# @plakboek/render

## 0.7.0

### Minor Changes

- [#22](https://github.com/flovan/plakboek/pull/22) [`ea4404b`](https://github.com/flovan/plakboek/commit/ea4404beec26a7f0de0e0818a11f469e601b120a) Thanks [@flovan](https://github.com/flovan)! - Editing a block component under `pnpm dev` now swaps just that block instead of reloading the page. The `plakboek()` Vite plugin tells a block change (a module the config reaches that the site document does not) from every other server change and sends the custom `plakboek:blocks-changed` event for it; changes to the config, the site document, route modules and anything outside the config's imports still reload the page. A small dev client, loaded on visitor pages and in the edit frame, fetches the page again and replaces the blocks whose markup changed, then runs their `rendered` hook; in the edit frame the editor's hooks runtime runs it, so the edit shell, the selection and the frame's scroll position stay. Visitor pages carry block markers and the dev client only under the dev server, never in a production response.

- [#22](https://github.com/flovan/plakboek/pull/22) [`cf42768`](https://github.com/flovan/plakboek/commit/cf4276815e5497f92b6f7412418a801386a1eec4) Thanks [@flovan](https://github.com/flovan)! - Every block component now receives a frozen `layout` prop (`columns`, `align`, `fill`), separate from its declared `props`. The root entry gains `Columns`, the CSS grid a host section renders around its children (ratio tracks, alignment and a `--plakboek-column-gap` gap, stackable with one container-query rule), `ColumnBlock`, the core column cell, `columnTracks`, `isLiveEdit`, and the `BlockLayout`, `ColumnAlign` and `ColumnsProps` types. The edit attribute contract names `data-pk-empty` and `data-pk-inline-editing`, and the live proxy and block metadata accept the `column` kind. `BlockComponentProps` has a new required `layout` field, so code that constructs it by hand must pass one.

- [#22](https://github.com/flovan/plakboek/pull/22) [`f245a23`](https://github.com/flovan/plakboek/commit/f245a235709cb71087f02f6209e0822433ac33b6) Thanks [@flovan](https://github.com/flovan)! - Add `defineBlockEdit` to the root entry: an identity helper with no runtime weight for declaring a block's editor lifecycle hooks (`enter`, `leave`, `select`, `deselect`, `reveal`, `rendered`), so an interactive block can react to selection and mode without its hook code reaching visitors. Add `renderBlockFragments` to the server entry: it renders any block of a live tree, subtree included, to exactly the markup the frame document shows for it. The package's types now name DOM globals (`Element`, `Document`, `Window`) for the hook context.

### Patch Changes

- [#22](https://github.com/flovan/plakboek/pull/22) [`1afbaa9`](https://github.com/flovan/plakboek/commit/1afbaa93bfdeba7e8d16a9026eaa9c1abba1ba25) Thanks [@flovan](https://github.com/flovan)! - Outside production, a live edit render now warns once for each block component whose markup carries no element with the block's identity, and names the block type. Such a block cannot be outlined, selected or reached by double-click in the page editor. The fix is to spread `{...edit}` on its root element. Visitor renders, plain renders and production stay silent.

- [#22](https://github.com/flovan/plakboek/pull/22) [`687b124`](https://github.com/flovan/plakboek/commit/687b1246c68c014329a7424b43a3e18399732b10) Thanks [@flovan](https://github.com/flovan)! - The visitor handler no longer relies on the host alone to keep the development block markers out of production. They are left out when `NODE_ENV` is `production` (as well as when a cache is configured), and a page rendered with them is always answered `Cache-Control: no-store`, so a `devBlockMarkers` flag set by mistake cannot expose block ids or the block catalogue, or let a proxy store such a page.

- Updated dependencies [[`46b1f42`](https://github.com/flovan/plakboek/commit/46b1f421d731aacabd70efba7ffdb31147049b46), [`4826b5e`](https://github.com/flovan/plakboek/commit/4826b5eb5e237c149761499e87465a4f9c88e84d), [`2e24024`](https://github.com/flovan/plakboek/commit/2e24024daf1ed40c2f5fb3be955a69fc7a5fabcb), [`679d143`](https://github.com/flovan/plakboek/commit/679d143b3ae393141721f7641f10a74443024fdf), [`58d4b90`](https://github.com/flovan/plakboek/commit/58d4b9042f843fd92543cc4775e897774820889d), [`93226b4`](https://github.com/flovan/plakboek/commit/93226b4b99bfe217130e05efacd94eb3a956e928), [`c352099`](https://github.com/flovan/plakboek/commit/c352099e3b6269c9b4514a2a3a3185a0d0d92736), [`03b865c`](https://github.com/flovan/plakboek/commit/03b865cd39b6ffe49ba10ec25c4a32047e42940e), [`c298afe`](https://github.com/flovan/plakboek/commit/c298afed08f9d64f27eca97576a9b3803245ff7f), [`bb3f473`](https://github.com/flovan/plakboek/commit/bb3f473e0547ff1760f524eeb51ca4204d05fd80), [`23bc841`](https://github.com/flovan/plakboek/commit/23bc841143b5bca5816378c183337116a8993bae), [`2f2f419`](https://github.com/flovan/plakboek/commit/2f2f419ab381404ab4b7b2a7a7af8e30ac4fd3ed)]:
  - @plakboek/pages@0.7.0
  - @plakboek/cache@0.7.0

## 0.6.0

### Minor Changes

- [#20](https://github.com/flovan/plakboek/pull/20) [`41afc1e`](https://github.com/flovan/plakboek/commit/41afc1e6e60582252ac0e47902479cc0eaff1654) Thanks [@flovan](https://github.com/flovan)! - Document composers now learn which rendering they produce: `DocumentInput` gains a required `mode: 'visitor' | 'edit'` (the new `DocumentMode` type), and the visitor handler always passes `'visitor'`. A host's document omits analytics and third-party widgets when `mode` is `'edit'` and keeps block-owned scripts. Anyone who constructs a `DocumentInput` by hand, a test or a custom composer wrapper for example, must now set `mode`.

  The Edit pill on visitor pages no longer jumps to `?_edit=1`: it navigates to `/cms?next=<current page>` so the server decides whether a session continues straight into editing or sees the login screen, and it never renders inside a frame. The two new constants `CMS_LOGIN_PATH` (`/cms`) and `NEXT_PARAM` (`next`) are exported from the root entry. The inline bootstrap text changed, so `TOOLBAR_BOOTSTRAP_CSP_HASH` changed: hosts that pin the hash in `script-src` should use the exported constant.

- [#20](https://github.com/flovan/plakboek/pull/20) [`93b8eae`](https://github.com/flovan/plakboek/commit/93b8eaeefb31f4e936fe9db02f874799a59a40da) Thanks [@flovan](https://github.com/flovan)! - Adds the live side of the edit proxy and a renderer for a page's working tree, for the editor's frame document. `createLiveEdit` returns an `EditProxy` that spreads `data-pk-block`, `data-pk-type`, `data-pk-kind` and `data-pk-label` onto a block's root element (`edit.field(name)` yields `data-pk-field`), with the names exported as `EDIT_ATTRIBUTE` from the root entry. `renderPageTree` renders a `BlockNode[]` through the same block containment the visitor snapshot path uses; in `live` mode a block that renders nothing (unknown type, degraded node, throwing or async component) becomes an inert placeholder that keeps the block's `kind` and `label` and is marked `data-pk-unavailable="unknown|degraded|failed"`, and `plain` mode renders visitor-identical markup with no `data-pk-*` attribute. `normalizeVisitorPath` and its `VisitorPathResult` type are now exported from the server entry. The visitor snapshot output is unchanged.

### Patch Changes

- Updated dependencies [[`ebb81f2`](https://github.com/flovan/plakboek/commit/ebb81f2682f2e3a097435166dead985050f36636)]:
  - @plakboek/pages@0.6.0
  - @plakboek/cache@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @plakboek/cache@0.5.1
  - @plakboek/pages@0.5.1

## 0.5.0

### Minor Changes

- [#15](https://github.com/flovan/plakboek/pull/15) [`acec821`](https://github.com/flovan/plakboek/commit/acec8217e77250d4e984becd7f210d77a4e04de9) Thanks [@flovan](https://github.com/flovan)! - A host document composer now receives `publicPath`, the canonical visitor path the page is served at (`/` for the home page, `/about`, `/nl` for a locale root), so a header or footer template can mark the current link. A composer may also return a `Promise<string>`: the handler awaits it inside the render guard, so a rejecting composer becomes the host 500 page with `Cache-Control: no-store`, is reported once through `onRenderError`, and is never cached. Synchronous composers, including `renderDefaultDocument`, keep working unchanged.

### Patch Changes

- Updated dependencies []:
  - @plakboek/pages@0.5.0
  - @plakboek/cache@0.5.0

## 0.2.0

### Minor Changes

- [#13](https://github.com/flovan/plakboek/pull/13) [`e4c4a07`](https://github.com/flovan/plakboek/commit/e4c4a0764683ba4d84f5a228da23bd1890da3da7) Thanks [@flovan](https://github.com/flovan)! - Add the @plakboek/render package: the block-authoring contract, the SEO head
  emitter and the default document composer for server-rendered visitor pages.

### Patch Changes

- Updated dependencies [[`e689d61`](https://github.com/flovan/plakboek/commit/e689d614e8dee1bd789b95399487b5af37fa34e5), [`47d17e5`](https://github.com/flovan/plakboek/commit/47d17e565631763e401e9cea754226519e01ca89), [`59c3119`](https://github.com/flovan/plakboek/commit/59c311953f5f5e9c5bd2ac83c5af9adfa13b3097), [`3153b25`](https://github.com/flovan/plakboek/commit/3153b25d7015c8c55f29c915ba90befda8f710b7), [`1f6ad90`](https://github.com/flovan/plakboek/commit/1f6ad90ba7865da636e32124a9f63d6beeb0cb1f), [`74a4e66`](https://github.com/flovan/plakboek/commit/74a4e66ff2dc30d11e723ddff4aa5edcfe6539f6), [`0f2e624`](https://github.com/flovan/plakboek/commit/0f2e6241337b58df2ba77fbe5f28e5fe1b0c0791), [`1ee5b62`](https://github.com/flovan/plakboek/commit/1ee5b625cc2650070a42036447f0ada2fe449cc7), [`8432ec7`](https://github.com/flovan/plakboek/commit/8432ec7cc443af889353e19104bb8e37bfc04738)]:
  - @plakboek/cache@0.2.0
  - @plakboek/pages@0.3.0
