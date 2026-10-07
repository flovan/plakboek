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

## HTTP response policy

Every response class has one caching policy, and nothing a host plugs in can
make an error cacheable.

| Response                                 | Status | `Cache-Control`                                                                                     |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| Method other than `GET` or `HEAD`        | 405    | `no-store`, with `Allow: GET, HEAD` and an empty body; answered before any cache or database access |
| Page                                     | 200    | `public, max-age=0, must-revalidate`, or the host's `cacheControl`                                  |
| Degraded page (a block was dropped)      | 200    | `no-store`, never overridden                                                                        |
| Unchanged page for a conditional request | 304    | the page's own policy, with its `ETag` and no body; never for a degraded page                       |
| Canonicalisation, locale and home        | 308    | `public, max-age=3600`                                                                              |
| `_edit` bounce for a non-editor          | 302    | `no-store` (wired in a later plan of this phase)                                                    |
| Not found                                | 404    | `no-store`; the body can be the host's `notFound` page                                              |
| Failed render                            | 500    | `no-store`; the body can be the host's `renderError` page                                           |

Page responses carry `Content-Type: text/html; charset=utf-8`, `Content-Language`
(the page's locale), `X-Content-Type-Options: nosniff` and an `ETag` (the
sha256 of the served bytes). There is no `Vary`: the locale is part of the URL,
and the page never depends on a request header.

A request whose `If-None-Match` names the page's `ETag` (the exact tag, a weak
`W/` form, an entry in a comma separated list, or `*`) is answered `304` with the
`ETag` and `Cache-Control` of the `200` and no body, from a cache hit at zero
database cost. `HEAD` runs the same pipeline as `GET` (a cold `HEAD` fills the
cache) and returns the same status and headers with an empty body.

- **Host not-found and error pages.** `notFound(request)` and
  `renderError(request)` return a `Response`. Its body and headers are kept, but
  its status is forced to `404` or `500` and its `Cache-Control` to `no-store`
  on a copy, and the proxy-targeted freshness and validator headers
  (`Surrogate-Control`, `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`,
  `Expires`, `ETag`, `Last-Modified`, `Age`) are removed, so a host page can
  never become a cacheable soft-404. A response from the edit entrypoint gets
  the same stripping with `Cache-Control: private, no-store`. A hook that
  throws, rejects or returns something that is not a `Response` is reported
  through `onRenderError` and replaced by the default page. The hook is called
  once per request, while a failure shared by concurrent requests is reported
  once. `page_url_history` is not consulted: redirects over it belong to a later
  phase.
- A stored URL pattern that no longer parses (written before pattern literals
  were restricted) addresses nothing: every request answers a `404` with
  `Cache-Control: no-store`, reported through `onRenderError` with a
  `PageUrlPatternError`, rather than a `500`. Replace the pattern with
  `setPageUrlPattern` to recover.
- **`cacheControl`.** Replaces the page policy on healthy `200` responses for a
  downstream layer the host can purge (compose it into the pages invalidator
  through `composeInvalidators`). Degraded pages, `404`, `405`, `500` and
  redirects keep their fixed policies. 1 to 256 printable ASCII characters,
  validated when the handler is created.
- **`buildId`.** Identifies the deployed render code, for example a commit hash
  (letters, digits, `.`, `_` and `-`, up to 128 characters, validated at
  creation). Entries are stored with it; an entry written by a different build is
  treated as a miss, re-rendered and overwritten, so HTML from an older build
  never survives a deploy on a shared or long-lived cache. Two builds sharing one
  cache during a rolling deploy therefore re-render each other's entries until
  the old build stops: correct, just more renders. A `global` purge stays
  available as the explicit alternative.

### Not handled here

The handler owns neither `robots.txt` nor a health endpoint: those are host
routes (Phase 6), and the sitemap belongs to Phase 16.

## Block rendering policy

One bad block never takes a page down.

- A block type with no component renders nothing and is reported through
  `onUnknownBlock({ blockType, blockId, pageId })`. This covers both a type the
  config no longer declares (a snapshot outlives the code that wrote it) and a
  type declared without a component. The page is still served 200 and stays
  cacheable, because the outcome is the same for a given snapshot and code.
- A block component that throws, whose returned elements throw (a shared
  image, a rich-text renderer, any nested component), or that returns a
  promise (rendering is synchronous), is dropped together with its subtree. Its siblings still render,
  `onBlockRenderError({ blockType, blockId, pageId, error })` fires once, and
  the response is served with `Cache-Control: no-store` and never written to the
  cache, so a transient error is not pinned.
- An error outside every block (the head, the document composer) fails the
  whole render. The handler reports `onRenderError` and answers a 500 with
  `Cache-Control: no-store`, no error text in the body, and nothing cached.
  A composer may be async: the handler awaits it inside the same guard, so a
  rejecting composer is that same uncached 500.
- A document composer receives `publicPath`, the canonical visitor path the
  page is served at (`/`, `/about`, `/nl`), the same value the page is cached
  under. A header or footer template can compare it with its links to mark the
  current one.
- A block declared with a `component` that is not a plain function (a `memo` or
  `forwardRef` object, a class component, any other value) is refused when the
  handler is created: `createVisitorHandler` throws one
  `VisitorHandlerConfigError` naming every offending block key. A block declared
  without a component is reported once through `onMissingComponent({ blockType })`
  and never refuses.
- Every hook goes through a never-throwing reporter: a hook that throws or
  rejects cannot break a render. With no hook set, the fallback logs ids and the
  error name only, never the error message, which may carry editor content.

## Visitor/edit seam

Editing happens on the rendered site itself, so a visitor page and an editing
request meet at one small seam.

- **The `_edit` request flow.** The server, never the client, decides. A request
  carrying `_edit` goes to an injected `EditEntrypoint`, a separate module the
  host composes into the handler, so the visitor handler imports nothing
  editor-related and editor code never reaches a visitor bundle. The entrypoint
  verifies the editor's session and resolves a `Response`, or `null` for anyone
  who may not edit, which the handler turns into a bounce to the same page
  without `_edit`.
- **The `EditEntrypoint` contract.** `(request, context) => Promise<Response |
null>`, where `context` is `{ url, visitorLocation }`. The editor package
  (a later phase) fills it. The bounce location is always a relative path with
  runs of `/` collapsed, so it can never redirect off the site.
- **The bootstrap.** `renderToolbarBootstrap()` returns one static inline
  `<script>` of at most 2 KB, framework-free, the same string on every call. It
  does nothing unless the non-secret `EDITOR_FLAG_KEY` flag is set in
  `localStorage` and `TOOLBAR_DISMISSED_KEY` is not. When active it shows an
  Edit pill in a closed shadow root, so the site's CSS cannot reach it, and
  navigates to the same URL with `_edit=1`. It fetches nothing and never grants
  anything: a client-side flag is only a hint that an editor signed in on this
  browser, and the server-side `_edit` handling decides who may edit. The editor
  sets and clears the flag at sign-in and sign-out.
- **CSP.** Shared caches serve identical bytes to every visitor, so a
  per-request nonce is impossible. Allow the script by its hash instead, with
  the exported constant: `script-src 'sha256-...'` where the value is
  `TOOLBAR_BOOTSTRAP_CSP_HASH`.
- **Keeping editor code out.** A module-graph test added later in this phase
  checks that no editor package is reachable from this package's build.

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
| `DocumentInput`         | type     | `{ head, body, publicPath }`: what a document composer receives        |
| `RenderDocument`        | type     | A host's document composer: `(input) => string \| Promise<string>`     |

### Server entry: `@plakboek/render/server`

| Export                       | Kind     | Purpose                                                                  |
| ---------------------------- | -------- | ------------------------------------------------------------------------ |
| `buildPageHead`              | function | Builds a page's head from its stored SEO set; never reads the request    |
| `renderHeadHtml`             | function | Renders a `PageHead` to escaped markup through `renderToStaticMarkup`    |
| `renderDefaultDocument`      | function | Wraps rendered body markup in a complete document with no script element |
| `createVisitorHandler`       | function | Builds the Fetch-standard visitor request handler over frozen deps       |
| `VisitorHandlerConfigError`  | class    | Thrown by `createVisitorHandler` with every invalid dependency           |
| `renderPageSnapshot`         | function | Renders a published snapshot to a head and a body through one React pass |
| `createComponentMap`         | function | Builds the block-type to component map from the host's block definitions |
| `PageHeadInput`              | type     | Input to `buildPageHead`                                                 |
| `PageSeoInput`               | type     | The stored SEO set as a structural type                                  |
| `VisitorHandler`             | type     | `(request: Request) => Promise<Response>`                                |
| `VisitorHandlerDeps`         | type     | Input to `createVisitorHandler`                                          |
| `VisitorHandlerConfigIssue`  | type     | One `createVisitorHandler` configuration problem                         |
| `renderToolbarBootstrap`     | function | The one inline script a visitor page carries; inert until an editor flag |
| `TOOLBAR_BOOTSTRAP_CSP_HASH` | constant | The `sha256-...` of that script's text, for a host's `script-src`        |
| `EditEntrypoint`             | type     | `(request, context) => Promise<Response \| null>`: the editor's entry    |
| `EditRequestContext`         | type     | The parsed URL and the `visitorLocation` an `EditEntrypoint` receives    |
| `ComponentMap`               | type     | A read-only map from block type to `BlockComponent`                      |
| `RenderPageSnapshotInput`    | type     | Input to `renderPageSnapshot`                                            |
| `RenderedPage`               | type     | The head, body, cache tags and degraded flag of a rendered page          |
| `RenderHooks`                | type     | Optional host hooks: unknown block, render error, cache error and more   |
| `UnknownBlockEvent`          | type     | What `onUnknownBlock` receives                                           |
| `MissingComponentEvent`      | type     | What `onMissingComponent` receives                                       |
| `BlockRenderErrorEvent`      | type     | What `onBlockRenderError` receives                                       |
| `RenderErrorEvent`           | type     | What `onRenderError` receives                                            |
| `CacheErrorEvent`            | type     | What `onCacheError` receives                                             |
