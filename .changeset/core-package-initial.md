---
'@plakboek/core': minor
---

First release of `@plakboek/core`, the host integration package. A host app built with React Router 8 spreads `cmsRoutes()` into its own route config, adds the `plakboek()` Vite plugin and starts `createServer()`: published pages are served at `/` and every other path through the visitor handler, next to the host's own routes. The package root exports `defineBlock` and the host-facing types and is safe to import from a client bundle.
