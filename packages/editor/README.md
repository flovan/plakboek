# @plakboek/editor

The on-page editing chrome for Plakboek. Editors work on the rendered site
itself; this package holds what surrounds the site while they do: the sidebar,
the login card, the overlay and the strings and icons they share. All of it
renders into shadow roots, styled by one precompiled stylesheet, so a site's
CSS cannot reach chrome and chrome cannot reach the site.

## Install

```sh
pnpm add @plakboek/editor react react-dom
```

`react` and `react-dom` are peer dependencies.

## Status

Pre-alpha. This release carries the chrome stylesheet and the helpers that
deliver it, and the server entry that answers the edit shell and the framed
site, with the client boot that hydrates the shell. The login card, the layout
toggle and the overlay arrive in later releases of the same phase.

## Browser floor

The editor targets current evergreen Chromium, Firefox and WebKit. It relies
on constructable stylesheets, declarative shadow DOM and the `:host` selector;
older browsers are not supported: without declarative shadow DOM the shell
renders no chrome, and `bootEditor()` finds no shadow root and does nothing.
Visitors never load this package, so the floor applies to editors only.

## How edit mode shows the site

Edit mode is two requests to the page's own address, both answered by the
edit entrypoint behind the visitor handler's `_edit` seam.

- `<page>?_edit=1` is the **shell**, a document the CMS owns. Its single
  `plakboek-editor` element carries a declarative shadow root with the
  sidebar and a stage, and the stage holds one same-origin `<iframe>` pointing
  at the second request. The iframe is used purely as a viewport.
- `<page>?_edit=frame` is the **site**, rendered by the host's own document
  and blocks at its own URL, for the live working tree (with `pages:edit`),
  and with the live `data-pk-*` attributes on every block.

The editor's own React code reaches into the frame's document directly, with
no cross-document message bridge. The site therefore keeps a real window
scroll and real media queries, sized exactly as the frame, and chrome and
site cannot style each other: they live in different documents, and the
chrome lives in shadow roots. The frame shows the actual rendered page, and
the editor adds nothing to it beyond what the host's `renderDocument` and
blocks produce plus the live attributes. The frame is shown at actual size
(1:1): entering or leaving full width resizes the frame, it never scales it.

Every shell and frame request re-reads the session, the two-factor gate and
the user's role on the server. Nothing a client sends other than the session
cookie grants anything, and the `plakboek:editor` flag in the browser only
decides whether the Edit pill appears.

| Request                                              | Answer                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| No session                                           | `null`: the visitor handler redirects to the plain page                                    |
| A role that needs two-factor and has not enrolled    | The shell redirects to `/cms/two-factor/enrol?next=<page>`; the frame answers `null`       |
| A user with `pages:edit`                             | The shell, and the frame with the live working tree and live attributes                    |
| A user with `pages:read-drafts` but not `pages:edit` | The read-only shell, and the working tree as plain markup                                  |
| Any other signed-in user                             | The read-only shell, and the published page                                                |
| A page that does not exist                           | The host's not-found document inside the frame, status 404                                 |
| A render that fails                                  | A small editor document with a `plakboek-frame-error` marker and no error text, status 500 |
| A frame URL opened as a top-level page               | A redirect to the shell for the same page                                                  |

Every shell and frame response carries `X-Robots-Tag: noindex, nofollow`. The
visitor handler serves them `private, no-store`.

### Wiring the entrypoint

`createEditEntrypoint(deps)` takes the auth instance, the permission
resolver, the database, the pages config and home slug, the component map the
visitor handler uses, the host's `renderDocument`, an optional `notFound`
page, and the editor assets. Pass the result as the visitor handler's `edit`.

`EditorAssets` describes the built client the shell loads:

| Field        | Meaning                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `entry`      | URL of the module that calls `bootEditor()`                                                                     |
| `preload`    | URLs of chunks to preload                                                                                       |
| `css`        | URLs of stylesheets the client chunks need                                                                      |
| `devScripts` | Development-only scripts (a URL or inline code) that run first; the shell then sends no Content-Security-Policy |

### What the shell sends

The shell is never framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`)
and sends no referrer. With `csp: true` it also sends a policy that allows
only its own origin plus two inline styles by hash: the chrome stylesheet,
whose source expression is `CHROME_STYLE_CSP_HASH`, and the document's one
static style, plus one inline script by hash: the layout script described
below. There is no `unsafe-inline`, and `base-uri` is `none`. The
frame is served with `X-Frame-Options: SAMEORIGIN` and
`frame-ancestors 'self'`, so only the shell can embed it.

A host's site pages must not send `X-Frame-Options: DENY` or
`frame-ancestors 'none'`: the frame is the site's own document at its own
address, and a policy that forbids same-origin framing would blank it.

The JSON the shell hands the client holds only what the chrome needs: the
mode, the user's name and email, the visitor location, the frame URL and the
log-out path. It is escaped so no value can close its script element.

### Layouts and the frame's behaviour

The shell opens **framed**: a 280px sidebar, and the page 24px from the stage
edges. The Full width toggle switches to a 56px rail with the page flush to
the rail, the top, the right and the bottom. The frame's own scroll position
is unchanged by the switch and the window itself never scrolls. When the toggle
has keyboard focus, focus moves with it to the toggle of the layout now shown,
so a keyboard user can switch straight back and focus never rests on a hidden
control. The choice is
kept per browser in `localStorage` under `plakboek:editor-layout` (`framed` or
`full`; anything else means framed). A small inline script right after the
`plakboek-editor` element applies a stored `full` before the first paint, so
the framed layout never flashes. It is constant text, and its hash is added to the
shell's `script-src` for you; a host never has to touch it. Before the client script has loaded the
Full width toggle is disabled, while Exit edit mode (an anchor) and Log out (a
form post) already work.

Below 1024px wide the frame is replaced by a panel asking for a wider window,
and it lifts without a reload when the window grows. If the frame's page
cannot be rendered for editing, the frame is replaced by a panel with a Reload
page button; nothing of the failure is shown.

The shell follows the frame without interfering with the site:

- a link to another page of the site navigates the whole page to that page
  in edit mode (`_edit=1`);
- a link to another site opens in a new tab with `noopener`;
- a link to a spot on the same page, a download, a link with its own `target`,
  a non-web link or a click with a modifier key is left to the browser;
- a link click the site's own script already handled (it called
  `preventDefault`) is left to the site;
- a frame that is navigated by a script or a form is followed by the whole
  page, in edit mode;
- the shell's title is the page's title followed by "Plakboek".

The shell's listener is attached once, in the bubble phase, and never stops an
event from travelling on, so a site's click, keyboard and scroll handling is
unaffected. Log out clears the `plakboek:editor` flag in the browser and posts
to the log-out path; Exit edit mode keeps the session and the flag.

### The sidebar slot

`SidebarSlots` describes the navigation region between the product name and
the footer. It receives the current layout so items can render icon-only in a
rail, and it renders nothing when no slot is given.

## The login page and the link landings

`createCmsPages(deps)` returns `{ handle(request) }`, the handler behind core's
`/cms` routes. It answers a response for the paths it owns and `null` for any
other, which core turns into the host's own 404. It takes the auth instance,
the permission resolver, the editor assets, `csp` and, when the installation
raised the password minimum in `createAuth`, that `passwordMinLength` (it
defaults to the auth package's own 12), so the choose-a-password hint and
messages name the real minimum. The page tells the
browser nothing about which roles must set up two-step sign-in: the server
sends a role that still has to set it up to the enrolment path.

| Path                    | Answer                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/cms`                  | No session: the sign-in card. A session: `302` to `<next>?_edit=1`. A role that still has to set up two-step sign-in: `302` to the enrolment path. |
| `/cms/set-password`     | The choose-a-password step when a `token` is present (1 to 512 characters), the invalid-link step otherwise                                        |
| `/cms/reset-password`   | The same, for a reset link                                                                                                                         |
| `/cms/magic-link`       | The "Signing you in" step when a session exists and the link did not fail, the invalid-link step otherwise                                         |
| `/cms/two-factor/enrol` | No session: `302` to `/cms?next=<page>`. Nothing to set up: `302` to `<page>?_edit=1`. Otherwise the confirm-password step                         |

Paths match without regard to case, and a trailing slash is ignored. Every
page is the login document: the real page named by `?next=` in a same-origin
iframe that fills the viewport, blurred by 12px, `inert`, hidden from
assistive technology and out of the tab order, a scrim over it, and the card in
a native `<dialog open>`. All of it is in the server's markup, in a declarative
shadow root, so the first paint already shows blur, scrim and card with no
script and no entrance animation. The iframe is static markup outside the
hydrated card, so hydrating never reloads it. `?next=` is accepted only as a
same-origin path (anything else is `/`), the same rule the edit redirects use.

A page that is framed behind the card is the site's own page, so a host's site
pages must allow same-origin framing here as they must for the edit frame.

A link's token never enters the page. The server only checks that one is
present; it is not copied into the markup or the JSON island, the document
sends `Referrer-Policy: no-referrer` so it cannot leave through a request the
page makes, and it is for the client to read it from the address bar and remove
it there.
An expired, used and malformed link share one heading and one sentence. Signing
in needs JavaScript in this release: the card's forms post to `/cms`, which
answers `405`, so a browser that never runs the editor cannot put a password in
an address.

## The editor API

`createEditorApi(deps)` returns `{ handle(request) }`, the handler behind core's
`/cms/api` routes. It answers `null` for a path outside `/cms/api/` and a JSON
`404` for an unknown path inside it. It takes the auth instance, the permission
resolver, the pages dependencies, the home slug, the visitor handler's component
map, optional render hooks and `siteOrigin`, the origin of this site.

The client of the editor never imports the pages package, so everything it needs
to draw legal drop targets and property controls comes from here: the block
catalogue is built on the server from the resolved block properties, which means
a property an installation hides never leaves the server, and a fixed or
narrowed one carries its constraint.

| Route                                                                 | Answer                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /cms/api/open` `{ path }`                                       | The page at that visitor path: id, version, locale, the catalogue, the flat tree, the lock, the column presets, whether the caller may delete, and the limits                                                             |
| `GET /cms/api/pages/:id/tree`                                         | The page's current version and flat tree                                                                                                                                                                                  |
| `GET /cms/api/pages/:id/lock`                                         | The lock as the caller may see it                                                                                                                                                                                         |
| `POST /cms/api/pages/:id/lock/acquire`                                | Takes the lock when it is free or already the caller's                                                                                                                                                                    |
| `POST /cms/api/pages/:id/lock/renew`                                  | The heartbeat; takes the lock again when nobody holds it any more                                                                                                                                                         |
| `POST /cms/api/pages/:id/lock/release`                                | Releases the caller's lock                                                                                                                                                                                                |
| `POST /cms/api/pages/:id/lock/take-over`                              | Takes the lock from its holder, allowed only when the caller's permissions are a superset of the holder's role, and audited                                                                                               |
| `POST /cms/api/pages/:id/edit` `{ basePageVersion, ops, fragments? }` | One batch of insert, update, move, delete and duplicate ops, applied together or not at all: the new page version, the flat tree, the created and deleted ids and, unless `fragments` is `false`, the patch for the frame |
| `POST /cms/api/pages/:id/preview` `{ blockId, props?, layout? }`      | One block's subtree rendered with candidate values, or the issues (keys and codes) a write would refuse them with. Writes nothing and takes no lock                                                                       |

Opening takes the edit lock when locking is on and the page is free, and brings
a page that predates columns into the column shape first. When someone else
holds a live lock, opening still answers with the session: its lock state is
`other`, with the holder's display name, when they were last active and whether
the caller may take over, and nothing is taken. A lock view never carries the
holder's email address, role or user id.

### Editing and previewing

An edit is one request. `ops` holds one to 50 operations against the page
version the client last saw (`basePageVersion`) and, per block, the version it
saw (`baseVersion`); a client may name the ids of blocks it inserts, so an undo
puts a deleted block back under its original id. The batch is checked against
the page it is posted to: a block of another page answers `404`. A batch with a
delete needs `pages:delete` on top of `pages:edit`. Props are a whole-object
replacement on `update`.

The answer's `patch` is what the frame needs to follow the change, rendered by
the blocks' own components. A batch of property updates patches only the updated
blocks. Any structural batch patches every top level section that held a
touched block before or after the change, lists the top level sections that are
gone in `removed`, and sends `rootOrder` when the order of the top level
changed. A fragment the server could not render is left out, and the client
reloads for it.

A preview checks the candidate values exactly as a write would, leniently for
required properties, and answers either `{ ok: true, html, needsInput }`, with
`needsInput` naming the required properties still empty, or `{ ok: false,
issues }`. Nothing is stored, no lock is taken and the page version does not
move, so a client can preview on every pause in typing.

### The request gate

Every request needs a session, read from the cookie on every request. A role
that must have a second factor and has none is refused. A caller needs
`pages:edit`. Every `POST` must be JSON and come from this site: its `Origin` is
`siteOrigin` or the request's own origin, or, when `Origin` is missing or
`null`, the browser's `Sec-Fetch-Site` is `same-origin`. A body is read through
a 1 MiB cap and validated; every answer is `Cache-Control: no-store` JSON.

An error answers `{ ok: false, error: { code } }`. A refused value adds `issues`
(keys and codes, never values), and a locked page adds the `lock` view. Nothing
else about the failure leaves the server.

| Status | Code                      | When                                                               |
| ------ | ------------------------- | ------------------------------------------------------------------ |
| 400    | `invalid-request`         | The body is not JSON or fails validation                           |
| 401    | `unauthenticated`         | No session                                                         |
| 403    | `forbidden`               | Cross-site request, no `pages:edit`, a takeover the engine refuses |
| 404    | `not-found`               | The page, block or route does not exist                            |
| 405    | `invalid-request`         | The path exists for another method                                 |
| 409    | `stale-page`              | The page changed since the version the request was made against    |
| 409    | `stale-block`             | A block changed since the version the request was made against     |
| 409    | `conflict`                | A client-chosen block id is already taken                          |
| 409    | `lock-changed`            | The lock changed hands while a takeover was being decided          |
| 409    | `locking-disabled`        | Page locking is switched off for this installation                 |
| 413    | `too-large`               | The body or the batch is over its limit                            |
| 415    | `invalid-request`         | The body is not `application/json`                                 |
| 422    | `placement`               | The placement, depth or nesting rules refuse the change            |
| 422    | `unknown-type`            | The block type is not declared                                     |
| 422    | `invalid-props`           | A property value is refused; `issues` name the keys                |
| 422    | `invalid-layout`          | A layout value is refused; `issues` name the keys                  |
| 422    | `section-column-required` | The change would leave a section without a column                  |
| 423    | `locked`                  | Another editor holds the page; `lock` says who, by display name    |
| 500    | `server-error`            | Anything else, logged by error name only                           |

## The chrome stylesheet

Chrome is styled by its own precompiled Tailwind v4 stylesheet, built at
package build time with `@tailwindcss/vite` through Vite's build API.

- **Shadow roots only.** The stylesheet is adopted by shadow roots and never
  added to the document, so a site's CSS cannot reach chrome and chrome cannot
  reach the site.
- **Pixels only.** Chrome sizes in `px`. A `rem` or `em` unit would rescale
  with a site's `html { font-size }`, so the build fails when one survives.
- **No preflight.** Only Tailwind's theme and utilities layers are compiled.
- **Shadow-root fix.** Tailwind v4 relies on `@property` for variables such as
  `--tw-translate-y` and `--tw-shadow`. `@property` is ignored in shadow
  trees, so the build unwraps Tailwind's `@supports` fallback and removes the
  `@property` rules, and fails if the expected block is missing.
- **One sheet per document.** `chromeStyleSheet(doc)` builds the sheet with
  that document's own `CSSStyleSheet` constructor, because a constructed sheet
  can only be adopted inside the document whose window made it.
- **First paint and CSP.** `chromeStyleElement()` returns the same CSS as a
  `<style>` element for a declarative shadow root, so chrome paints before any
  script runs. Constructed sheets are not subject to a strict `style-src`;
  that `<style>` element is. A host with a strict policy allows it with
  `CHROME_STYLE_CSP_HASH`: `style-src 'sha256-...'`, where the value is the
  exported constant.

## Colour tokens

Chrome has its own tokens, defined on the shadow host as `--pk-*` custom
properties, for a light and a dark scheme. They follow the browser's
`prefers-color-scheme`, and a `data-theme="light"` or `data-theme="dark"`
attribute on the host overrides the preference in either direction, which is
where a later theme toggle plugs in. The site's own colour scheme is never
read or changed: `color-scheme` is set on the host only. Under forced colours
the overlay and the focus ring use the system colours.

## Strings

Every string edit mode shows lives in one module, `STRINGS`, keyed by stable
dotted names such as `login.signIn.submit`. Components ask for a key, never
for English text, so adding a translation later changes no component. A
`{name}` in a value is a variable; `formatString(key, { name })` fills it, and
the types require exactly the variables a key names. Values are plain text and
are never escaped here: React escapes them when it renders.

## Icons

Six inline SVG icons (frame, expand, exit, log-out, spinner, alert) draw in
`currentColor` at 16px or 20px and are hidden from assistive technology. The
spinner rotates only where the browser allows motion.

## Public API

Every export of `@plakboek/editor`, grouped by entry. The client entry reaches
no server-only module; `tests/unit/public-api.test.ts` compares these tables
with the entry points, so an export cannot be added or removed without
updating them.

### Server entry: `@plakboek/editor/server`

| Export                        | Kind     | Purpose                                                                           |
| ----------------------------- | -------- | --------------------------------------------------------------------------------- |
| `createEditEntrypoint`        | function | The edit entrypoint for the visitor handler's `edit` option: the shell and frame  |
| `createCmsPages`              | function | The `/cms` pages handler: the login document and the email-link landings          |
| `createEditorApi`             | function | The editor's JSON API under `/cms/api`: open a page, read its tree, keep its lock |
| `EDITOR_API_BODY_LIMIT_BYTES` | constant | The most a request body to that API may hold: 1 MiB                               |
| `chromeStyleElement`          | function | The chrome stylesheet as `<style>` markup for a declarative shadow root           |
| `CHROME_STYLE_CSP_HASH`       | constant | The `sha256-...` of that markup's CSS, for a host's strict `style-src`            |
| `EditEntrypointDeps`          | type     | What `createEditEntrypoint` needs                                                 |
| `CmsPages`                    | type     | What `createCmsPages` returns: `handle(request)`, a response or `null`            |
| `CmsPagesDeps`                | type     | What `createCmsPages` needs                                                       |
| `EditorApi`                   | type     | What `createEditorApi` returns: `handle(request)`, a response or `null`           |
| `EditorApiDeps`               | type     | What `createEditorApi` needs                                                      |
| `EditorAssets`                | type     | The built client the shell loads: entry, preloads, stylesheets, dev scripts       |
| `EditorDevScript`             | type     | A development-only script: a `src` URL or inline `code`                           |

### Client entry: `@plakboek/editor/client`

| Export              | Kind     | Purpose                                                                                         |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `bootEditor`        | function | Hydrates the shell the server rendered inside the `plakboek-editor` host; takes `{ blockEdit }` |
| `chromeStyleSheet`  | function | The chrome stylesheet for one document, built with that document's window                       |
| `adoptChromeStyles` | function | Adopts the chrome stylesheet into a shadow root, once                                           |
| `STRINGS`           | constant | Every edit-mode string, by stable dotted key, in English                                        |
| `formatString`      | function | A string with its `{name}` placeholders filled; the compiler checks the names                   |
| `SidebarSlots`      | type     | The slots a later release fills the sidebar with                                                |
| `StringKey`         | type     | A key of `STRINGS`                                                                              |
| `BootEditorOptions` | type     | The options of `bootEditor`: `blockEdit`, the host's block edit module loaders                  |
| `BlockEditLoaders`  | type     | One lazy import per `*.edit.ts` block edit module, keyed by project path                        |

`bootEditor(document, { blockEdit })` is called by the editor chunk the
`plakboek()` Vite plugin builds, not by a host. `blockEdit` holds one lazy
loader per `*.edit.ts` or `*.edit.tsx` module (the plugin's `blockEdit` option
says where to look). After the shell hydrates it loads them once and keeps each
module whose default export is `{ blockType, hooks }` with function hooks. A
module that fails to load, has another shape, or repeats a block type is
reported once by file key and skipped, and the first module per block type wins.

### Hot entry: `@plakboek/editor/hot`

| Export               | Kind     | Purpose                                                                                         |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `createDevBlockSwap` | function | Swaps the blocks whose own markup changed between two server renders, or reloads the page       |
| `readSignatures`     | function | Every block of a document by id: its parent block and its own markup, nested blocks stood in    |
| `diffSignatures`     | function | The outermost changed blocks between two signature maps, and whether the set or nesting changed |
| `SignatureMap`       | type     | What `readSignatures` returns                                                                   |

Development only, and loaded by the core dev client, never by a host or by
the editor client. It has no React, server or chrome code in its graph. A swap
fetches the page again and compares each block's own markup, with the blocks
nested in it replaced by placeholders, so a change inside a child does not mark
its parent. Only the outermost changed blocks are replaced, through the same
fragment patch the editor uses: scripts in the new markup stay inert (a block
re-binds through its `rendered` hook), the scroll position is put back, and a
block that is being edited in place is left alone and tried again by the next
swap. A change in which blocks exist or how they nest reloads the page. Each
swap that replaces something fires `plakboek:blocks-swapped` on the document,
with the swapped ids in `detail.ids`.
