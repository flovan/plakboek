# @plakboek/core

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
