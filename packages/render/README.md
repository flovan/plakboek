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
Block error containment is in place;
conditional requests, HEAD and concurrent-fill coalescing land in later plans
of the same phase. No block, section or block
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

## Request handling

Every request goes through the same steps in the same order:

1. **Canonicalise** the path. Runs of `/` collapse, a trailing `/` is dropped
   (except for `/`) and letters are lowercased. A request that is not already
   canonical gets a `308` to the canonical spelling, with the query string
   preserved, `Cache-Control: public, max-age=3600` and a `Location` that is
   always a same-origin path starting with exactly one `/`. A path that cannot
   be a stored address (anything outside lowercase letters, digits, hyphens and
   single slashes, or longer than 2048 characters) is a `404` with
   `Cache-Control: no-store`, answered without a database statement or a cache
   lookup. This is complete because a page URL pattern's literals are limited
   to that same alphabet (`@plakboek/pages`).
2. **Look up the cache** under the canonical path (a cache ticket is taken
   first).
3. **Resolve** the published page on a miss: the unprefixed default locale
   (`/en/about-us` redirects to `/about-us`), the locale root serving the
   `home` page (`/home` redirects to `/`, `/nl/home` to `/nl`), and a `404`
   for an unknown or removed locale or a missing page. Redirects and `404`s
   are never cached.
4. **Render** the published snapshot.
5. **Store** the HTML under the canonical path.

The ticket makes a publish safe under load. A cache ticket is taken before any
data is read, and the fill passes it back: if the page was purged after the
ticket (a publish committed while this render was in flight), the cache refuses
the fill, so a render that read pre-publish data can never overwrite what
comes after it, and the next visitor gets the new version. With a cache,
concurrent misses for the same canonical path and the same ticket share one
render; the ticket is part of that sharing key, so a request that took its
ticket after a purge never joins a render that started before it. Without a
cache nothing is shared and every request renders.

## Block rendering policy

One bad block never takes a page down.

- A block type with no component renders nothing and is reported through
  `onUnknownBlock({ blockType, blockId, pageId })`. This covers both a type the
  config no longer declares (a snapshot outlives the code that wrote it) and a
  type declared without a component. The page is still served 200 and stays
  cacheable, because the outcome is the same for a given snapshot and code.
- A block component that throws, or returns a promise (rendering is
  synchronous), is dropped together with its subtree. Its siblings still render,
  `onBlockRenderError({ blockType, blockId, pageId, error })` fires once, and
  the response is served with `Cache-Control: no-store` and never written to the
  cache, so a transient error is not pinned.
- An error raised by an element a block returns, below the block's own call,
  is outside that containment and fails the whole render. The handler reports
  `onRenderError` and answers a 500 with `Cache-Control: no-store`, no error
  text in the body, and nothing cached.
- A block declared with a `component` that is not a plain function (a `memo` or
  `forwardRef` object, a class component, any other value) is refused when the
  handler is created: `createVisitorHandler` throws one
  `VisitorHandlerConfigError` naming every offending block key. A block declared
  without a component is reported once through `onMissingComponent({ blockType })`
  and never refuses.
- Every hook goes through a never-throwing reporter: a hook that throws or
  rejects cannot break a render. With no hook set, the fallback logs ids and the
  error name only, never the error message, which may carry editor content.

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
