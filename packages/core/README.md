# @plakboek/core

The host integration package for a Plakboek site. A scaffolded host app
composes this package into its own React Router 8 application: `cmsRoutes()`
supplies the CMS's routes, the `plakboek()` Vite plugin connects the package's
route modules to the host's configuration and site module, and `createServer()`
is the production server that serves a published page from Postgres next to the
host's own routes.

You normally do not install this by hand: `npx create-plakboek` writes a host
that already depends on it.

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

## What a host provides

A host is four small files plus its own blocks and site chrome.

`app/routes.ts` lists the host's own routes first and spreads the CMS routes
after them, so a host route wins every tie, including an index route at `/`:

```ts
import { cmsRoutes } from '@plakboek/core/routes';
import type { RouteConfig, RouteConfigEntry } from '@react-router/dev/routes';

const hostRoutes: RouteConfigEntry[] = [];

export default [...hostRoutes, ...cmsRoutes()] satisfies RouteConfig;
```

`vite.config.ts` adds the plugin next to React Router's:

```ts
import { plakboek } from '@plakboek/core/vite';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    plakboek({
      config: './plakboek.config.ts',
      site: './app/site/index.ts',
    }),
    reactRouter(),
  ],
});
```

`server.ts` is the production entry point:

```ts
import { createServer } from '@plakboek/core/server';

await createServer().start();
```

`plakboek.config.ts` default-exports the result of `defineConfig` from
`@plakboek/core/config`: the site name, locales, default locale, timezone,
blocks, menus, modules, roles and an optional seed page. Everything structural
is declared in this file and checked when it is evaluated, so a bad
configuration fails the process at start. A block file imports `defineBlock`
from the package root, which stays safe for a client bundle.

The site module (`app/site/index.ts` in the starter) exports `renderDocument`
and, optionally, `renderNotFound` and `renderError`; each receives a site
context with the site name, locale, current path and `getMenu(name)`.

## Environment

The runtime reads and validates these variables once, collects every problem
and fails with all of them listed, never printing a value. In development the
plugin loads `.env` from the project root; variables already set in the
process win over the file.

| Variable                               | Required | Meaning                                                                                                                                                                                          |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                         | yes      | Postgres connection string (`postgres://` or `postgresql://`).                                                                                                                                   |
| `DATABASE_MIGRATION_URL`               | no       | A direct (session) connection used only by `plakboek migrate`; falls back to `DATABASE_URL`. Migrations need it when `DATABASE_URL` is a pooler.                                                 |
| `PLAKBOEK_URL`                         | yes      | The installation's public origin, such as `https://www.example.org`. No path, query or fragment. Never derived from a request.                                                                   |
| `PLAKBOEK_SECRET`                      | yes      | At least 32 characters, no fallback in any environment. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.                                 |
| `PLAKBOEK_BUILD_ID`                    | no       | Identifies the deployed render code, such as a commit hash. Letters, digits, `.`, `_` and `-`, up to 128 characters.                                                                             |
| `PLAKBOEK_TRUSTED_PROXIES`             | no       | Comma-separated IP addresses or CIDR ranges of the reverse proxies in front of the app, such as `172.18.0.0/16`. Lets the request limiter find the real client in a multi-hop `X-Forwarded-For`. |
| `PLAKBOEK_CLIENT_IP_HEADERS`           | no       | Comma-separated header names the client address is read from, such as `CF-Connecting-IP`. Only for a proxy that sets that header itself and always overwrites it. Default `X-Forwarded-For`.     |
| `PLAKBOEK_SMTP_HOST`                   | no       | The SMTP server. The rest of the SMTP group is read only when this is set.                                                                                                                       |
| `PLAKBOEK_SMTP_PORT`                   | no       | SMTP port, 1 to 65535.                                                                                                                                                                           |
| `PLAKBOEK_SMTP_SECURE`                 | no       | `true` for implicit TLS (port 465), `false` otherwise.                                                                                                                                           |
| `PLAKBOEK_SMTP_USER`                   | no       | SMTP user; must be set together with `PLAKBOEK_SMTP_PASS`.                                                                                                                                       |
| `PLAKBOEK_SMTP_PASS`                   | no       | SMTP password; must be set together with `PLAKBOEK_SMTP_USER`.                                                                                                                                   |
| `PLAKBOEK_MAIL_FROM`                   | no       | The sender address for outgoing mail, such as `no-reply@example.org`.                                                                                                                            |
| `PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS` | no       | How long `plakboek migrate` waits for another migrator (default 120).                                                                                                                            |
| `PLAKBOEK_BOOTSTRAP_PASSWORD`          | no       | The password `plakboek bootstrap` uses when it is not given on stdin or at a prompt.                                                                                                             |
| `PORT`                                 | no       | The production server's port (default 3000).                                                                                                                                                     |
| `HOST`                                 | no       | The production server's bind address (default `0.0.0.0`).                                                                                                                                        |

## Routes and reserved paths

`cmsRoutes()` returns these routes, in this order, each pointing at a built
route module inside this package:

| Path                    | Purpose                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/cms`                  | The login page: the real page blurred behind a sign-in card.                                                                |
| `/cms/health`           | Liveness and database probe (`200` or `503`).                                                                               |
| `/cms/setup`            | First-run setup of the first superadmin.                                                                                    |
| `/cms/setup/test-email` | Sends a test email from the setup page.                                                                                     |
| `/cms/logout`           | `POST` only: ends the session and returns to the page the user left.                                                        |
| `/cms/*`                | The email-link landings (set password, reset password, sign-in link, two-step set-up); anything else is the host's own 404. |
| `/robots.txt`           | Disallows `/cms`. A host's own `public/robots.txt` is served instead.                                                       |
| `/api/auth/*`           | The authentication API.                                                                                                     |
| `/` and `/*`            | The visitor route: published pages, from Postgres.                                                                          |

`/cms` and everything under it, and `/api/auth/*`, are reserved for the CMS. No
path under `/cms` ever falls through to the visitor route, and every answer
under `/cms` (including health, setup, logout and the 404) carries
`X-Robots-Tag: noindex, nofollow`, set by the route modules themselves so it
holds in `react-router dev` as well. A page whose first slug segment is `cms`
or `api` would be shadowed by these routes, so the page engine now refuses to
create one, and the host runtime reports any that already exists, once, when
it is first built (through the `onReservedPagePath` pages hook, default a
console warning). Such a page is kept as it is; rename it to make it reachable.
A host's own routes win over every CMS route when they come first in
`app/routes.ts`.

`/cms` with a valid session goes straight to the page in edit mode; without one
it shows the sign-in card over the page named by `?next=`, which must be a path
on this site (anything else is `/`). `POST /cms/logout` is accepted only from
this site's own pages (`Origin`, or `Sec-Fetch-Site: same-origin` when the
browser sends no usable origin), reads at most 2 KB and answers `303` to the
sanitised `next`, never to an address with `_edit`.

The health body is a fixed `{"status":"ok"}` or `{"status":"unavailable"}`;
a database error never reaches the response.

The visitor route reads only the published snapshot of a page and renders it on
the server, with no client React. In production one in-process LRU cache per
app container holds rendered pages, and a publish purges the page right after
its transaction commits. Every other `NODE_ENV` runs uncached, so the next
request re-evaluates the host configuration.

## Edit mode

A request carrying `_edit` (`/about?_edit=1`) is handed to the editor, which
checks the session on the server and either serves the edit shell or bounces
to the plain page. The editor is composed automatically: the runtime builds it
on the first `_edit` request of a process, from its own authentication,
permissions, database, page configuration and site document, so a host does
nothing to get it. The plugin's `edit` option names a module exporting `edit`,
an entrypoint of your own, and still overrides the CMS editor entirely.

The editor's client is delivered as a separate chunk. `react-router build`
emits it as `assets/plakboek-editor-<hash>.js`, next to a
`plakboek-editor.json` sidecar that lists the chunk, the chunks it loads and
its stylesheets. The server build reads that sidecar, so it knows the hashed
URL without Vite's own manifest, and only the edit shell references it: a
visitor's page never mentions the editor.

Keeping editor code away from visitors is checked at build time, not by a
runtime branch. Two checks together are the gate, and a failure of either fails
the build in every host and in CI:

1. the render package's module-graph test, which keeps the editor out of the
   visitor handler's server graph;
2. a client-closure check in the plugin: after the client build, no chunk
   reachable from the client entry or from any route chunk, statically or
   through a dynamic import, may contain a module of `@plakboek/editor` (or of
   the editor's libraries). The build stops and lists every
   `entry -> chunk: module` path it found.

A host's own route modules, components and client entry must therefore never
import `@plakboek/editor`; the editor loads only through its own chunk.

## The `plakboek` command

The package ships a `plakboek` bin. Each command loads `.env` from the current
directory first. Exit codes: `0` success, `1` failure, `2` bad usage.

| Command                        | What it does                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `plakboek migrate`             | Applies the core database migrations under an advisory lock, so two deploys cannot double-apply. `--lock-wait <seconds>` bounds the wait. |
| `plakboek bootstrap`           | Creates the first superadmin and publishes the seed home page; only on an installation with no users. The password is never a flag.       |
| `plakboek mail:test <address>` | Sends one test email through the real mail transport to check delivery. Needs no database, secret or host configuration.                  |

`plakboek --version` prints the installed version and `plakboek --help` lists
the commands.

`plakboek migrate` applies only the core package's migrations. A host that adds
its own Drizzle schema keeps a separate migration history and runs it with its
own tooling.

## Public API

Each entry point below is pinned by a test: a name added to or removed from an
entry, or from its table here, fails the build.

### Root entry: `@plakboek/core`

Safe to import from any bundle, including the editor and every block module.

| Name                  | Kind     | Purpose                                                                  |
| --------------------- | -------- | ------------------------------------------------------------------------ |
| `defineBlock`         | function | Declares one block; an identity with type inference.                     |
| `defineModule`        | function | Declares a named bundle of blocks, field types, widgets and constraints. |
| `HostBlockDefinition` | type     | A block definition with its render component.                            |
| `HostModule`          | type     | What the virtual host module resolves to.                                |
| `MenuDefinitions`     | type     | Menus by name, declared in code.                                         |
| `MenuItem`            | type     | One menu item: a label and an `href`.                                    |
| `MenuLabel`           | type     | A label: one string, or a record keyed by locale.                        |
| `ModuleDefinition`    | type     | A module's contributions.                                                |
| `PlakboekConfig`      | type     | The frozen, validated configuration `defineConfig` returns.              |
| `PlakboekConfigInput` | type     | What `defineConfig` accepts.                                             |
| `ResolvedMenuItem`    | type     | A menu item resolved for one locale and the current path.                |
| `SeedBlock`           | type     | One block of the seed page.                                              |
| `SeedPage`            | type     | The page a fresh installation is seeded with.                            |
| `SiteContext`         | type     | What a site module receives alongside the page it composes.              |
| `SiteModule`          | type     | The host's site chrome: the document around every page.                  |

### Config entry: `@plakboek/core/config`

Server side only.

| Name                      | Kind     | Purpose                                                            |
| ------------------------- | -------- | ------------------------------------------------------------------ |
| `defineConfig`            | function | Validates the host configuration and returns it frozen.            |
| `PlakboekConfigError`     | class    | Thrown with every problem found, collected first.                  |
| `defaultRoles`            | constant | The role-to-permission mapping used when a host declares no roles. |
| `PlakboekConfigIssue`     | type     | One problem: a code and a message.                                 |
| `PlakboekConfigIssueCode` | type     | The closed set of problem codes.                                   |

### Routes entry: `@plakboek/core/routes`

| Name        | Kind     | Purpose                                                       |
| ----------- | -------- | ------------------------------------------------------------- |
| `cmsRoutes` | function | The CMS's route table, to spread after the host's own routes. |

### Vite entry: `@plakboek/core/vite`

| Name                    | Kind     | Purpose                                                                 |
| ----------------------- | -------- | ----------------------------------------------------------------------- |
| `plakboek`              | function | The Vite plugin that wires the host configuration to the route modules. |
| `PlakboekPluginOptions` | type     | The plugin's options: `config`, `site` and an optional `edit`.          |

### Server entry: `@plakboek/core/server`

| Name                  | Kind     | Purpose                                                              |
| --------------------- | -------- | -------------------------------------------------------------------- |
| `createServer`        | function | The production server: static assets, then the React Router handler. |
| `CreateServerOptions` | type     | Build paths, port, host and shutdown bound.                          |
| `PlakboekServer`      | type     | The Hono `app` and `start()`.                                        |
| `RunningServer`       | type     | A started server's port, host and `close()`.                         |

### Internal: `./route-modules/*`

The `./route-modules/*` subpath exists only so `cmsRoutes()` can point React
Router at the built route modules. It is internal: not part of the public API,
not covered by any compatibility promise, and subject to change in any release.
