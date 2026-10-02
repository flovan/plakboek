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

The block-authoring contract (`BlockComponent`, `EditProxy`, `NOOP_EDIT`) and
the database-free leaf renderers on the server entry (the SEO head emitter
and the default document composer) are implemented. The visitor request
handler lands in a later plan of the same phase. No block, section or block
component ships here: the block catalogue belongs to the host, and a later
phase supplies the built-in one.

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

| Export                  | Kind     | Purpose                                                                  |
| ----------------------- | -------- | ------------------------------------------------------------------------ |
| `buildPageHead`         | function | Builds a page's head from its stored SEO set; never reads the request    |
| `renderHeadHtml`        | function | Renders a `PageHead` to escaped markup through `renderToStaticMarkup`    |
| `renderDefaultDocument` | function | Wraps rendered body markup in a complete document with no script element |
| `PageHeadInput`         | type     | Input to `buildPageHead`                                                 |
| `PageSeoInput`          | type     | The stored SEO set as a structural type                                  |
