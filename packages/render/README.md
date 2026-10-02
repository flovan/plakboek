# @plakboek/render

Server-only rendering of published Plakboek pages. A host declares its blocks
in `@plakboek/pages`; this package supplies the typed contract a block
component is written against and, behind a separate server entry, the pieces
that turn a published page into HTML: the SEO head emitter and the default
document composer.

## Install

```sh
pnpm add @plakboek/render react react-dom
```

`react` and `react-dom` are peer dependencies.

## Status

The block-authoring contract (`BlockComponent`, `EditProxy`, `NOOP_EDIT`), the
SEO head emitter, the default document composer, the snapshot renderer and a
first visitor request handler (`createVisitorHandler`) are implemented: a
published page is served as complete server-rendered HTML, repeat requests
come from an optional cache, and a publish purges the page after commit.
Conditional requests, HEAD, concurrent-fill coalescing and block error
containment land in later plans of the same phase. No block, section or block
component ships here: the block catalogue belongs to the host, and a later
phase supplies the built-in one.

## The visitor handler

`createVisitorHandler(deps)` returns a Fetch-standard
`(request: Request) => Promise<Response>`. It needs no framework and no HTTP
server, and holds no module-level state, so two handlers in one process work
independently.

```ts
const handler = createVisitorHandler({ db, config, cache });
const response = await handler(new Request('https://example.com/about-us'));
```

- The component for each block comes from `config.blocks`, built once when the
  handler is created.
- The cache key is the URL path; a query string is never part of it. Without
  `cache` nothing is stored and every request renders.
- On a miss the handler reads only the published snapshot, never the working
  block tree, so editing a page changes nothing a visitor receives until the
  next publish.
- The cache ticket is taken before any database read, so a fill that races a
  purge is refused. Pass the same cache object to the page engine as
  `PagesDeps.invalidator` so a publish purges it after commit.
- A cache or render failure is reported through the `RenderHooks` and never
  surfaces as error detail in a response.

## Root versus server entry

The package publishes two subpaths.

- `@plakboek/render` is the block-authoring contract. It is safe to import
  from any bundle, including the editor and every block module: it imports no
  `react-dom/server`, no `drizzle-orm`, no `@plakboek/pages` value and no
  `node:` builtin.
- `@plakboek/render/server` holds everything that renders to a string or
  touches the server. Import it only from server code.

## Public API

Every export of `@plakboek/render`, grouped by entry and the way each entry's
source groups them. `tests/unit/public-api.test.ts` compares these tables
with the entry points, so an export cannot be added or removed without
updating them.

### Root entry: `@plakboek/render`

| Export                  | Kind     | Purpose                                                                |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `EDIT_PARAM`            | constant | `_edit`: the query parameter that asks for the editor entry            |
| `EDITOR_FLAG_KEY`       | constant | The localStorage key marking a signed-in editor                        |
| `TOOLBAR_DISMISSED_KEY` | constant | The localStorage key marking a dismissed toolbar                       |
| `NOOP_EDIT`             | constant | The visitor-side edit proxy: spreads to nothing, costs nothing         |
| `BlockIdentity`         | type     | `id`, `blockType` and `schemaVersion` of a rendered block              |
| `BlockComponentProps`   | type     | What the renderer passes a block: `block`, `props`, `children`, `edit` |
| `BlockComponent`        | type     | A block's render function: a plain function of `BlockComponentProps`   |
| `EditAttributes`        | type     | `data-` attributes the editor binds to                                 |
| `EditProxy`             | type     | Root attributes plus `field(property)` for per-property attributes     |
| `PageHead`              | type     | What a document composer needs to write a page's `<head>`              |
| `DocumentInput`         | type     | `{ head, body }`: what a document composer receives                    |
| `RenderDocument`        | type     | A host's document composer: `(input) => string`                        |

### Server entry: `@plakboek/render/server`

| Export                      | Kind     | Purpose                                                                  |
| --------------------------- | -------- | ------------------------------------------------------------------------ |
| `buildPageHead`             | function | Builds a page's head from its stored SEO set; never reads the request    |
| `renderHeadHtml`            | function | Renders a `PageHead` to escaped markup through `renderToStaticMarkup`    |
| `renderDefaultDocument`     | function | Wraps rendered body markup in a complete document with no script element |
| `createVisitorHandler`      | function | Builds the Fetch-standard visitor request handler over frozen deps       |
| `VisitorHandlerConfigError` | class    | Thrown by `createVisitorHandler` with every invalid dependency           |
| `renderPageSnapshot`        | function | Renders a published snapshot to a head and a body through one React pass |
| `createComponentMap`        | function | Builds the block-type to component map from the host's block definitions |
| `PageHeadInput`             | type     | Input to `buildPageHead`                                                 |
| `PageSeoInput`              | type     | The stored SEO set as a structural type                                  |
| `VisitorHandler`            | type     | `(request: Request) => Promise<Response>`                                |
| `VisitorHandlerDeps`        | type     | Input to `createVisitorHandler`                                          |
| `VisitorHandlerConfigIssue` | type     | One `createVisitorHandler` configuration problem                         |
| `ComponentMap`              | type     | A read-only map from block type to `BlockComponent`                      |
| `RenderPageSnapshotInput`   | type     | Input to `renderPageSnapshot`                                            |
| `RenderedPage`              | type     | The head, body, cache tags and degraded flag of a rendered page          |
| `RenderHooks`               | type     | Optional host hooks: unknown block, render error, cache error and more   |
| `UnknownBlockEvent`         | type     | What `onUnknownBlock` receives                                           |
| `MissingComponentEvent`     | type     | What `onMissingComponent` receives                                       |
| `BlockRenderErrorEvent`     | type     | What `onBlockRenderError` receives                                       |
| `RenderErrorEvent`          | type     | What `onRenderError` receives                                            |
| `CacheErrorEvent`           | type     | What `onCacheError` receives                                             |
