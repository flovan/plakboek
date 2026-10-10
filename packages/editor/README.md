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

Pre-alpha. This release carries the package shell: the chrome stylesheet and
the helpers that deliver it. The shell, the login card and the overlay arrive
in later releases of the same phase.

## Browser floor

The editor targets current evergreen Chromium, Firefox and WebKit. It relies
on constructable stylesheets, declarative shadow DOM and the `:host` selector;
older browsers are not supported. Visitors never load this package, so the
floor applies to editors only.

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

## Public API

Every export of `@plakboek/editor`, grouped by entry. The client entry reaches
no server-only module; `tests/unit/public-api.test.ts` compares these tables
with the entry points, so an export cannot be added or removed without
updating them.

### Server entry: `@plakboek/editor/server`

| Export                  | Kind     | Purpose                                                                 |
| ----------------------- | -------- | ----------------------------------------------------------------------- |
| `chromeStyleElement`    | function | The chrome stylesheet as `<style>` markup for a declarative shadow root |
| `CHROME_STYLE_CSP_HASH` | constant | The `sha256-...` of that markup's CSS, for a host's strict `style-src`  |

### Client entry: `@plakboek/editor/client`

| Export              | Kind     | Purpose                                                                   |
| ------------------- | -------- | ------------------------------------------------------------------------- |
| `chromeStyleSheet`  | function | The chrome stylesheet for one document, built with that document's window |
| `adoptChromeStyles` | function | Adopts the chrome stylesheet into a shadow root, once                     |
