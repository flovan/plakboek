# @plakboek/core

The host integration package for a Plakboek site. A scaffolded host app
composes this package into its own React Router 8 application: `cmsRoutes()`
supplies the CMS's routes, the `plakboek()` Vite plugin connects the package's
route modules to the host's configuration and site module, and `createServer()`
is the production server that serves a published page from Postgres next to the
host's own routes.

## Install

```sh
pnpm add @plakboek/core react react-dom react-router
```

`react`, `react-dom` and `react-router` are peer dependencies. A host that
builds with React Router also has `@react-router/dev` and `vite`; they are
optional peers because only the build-time subpaths import them. Node 22.22 or
later is required.

## Status

Pre-alpha: the API settles over phase 6. The package root (`defineBlock` and the
host-facing types) is safe to import from a client bundle; everything
server-side lives behind the `./config`, `./routes`, `./vite` and `./server`
subpaths.
