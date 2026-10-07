# @plakboek/render

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
