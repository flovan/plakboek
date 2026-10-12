# @plakboek/render

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
