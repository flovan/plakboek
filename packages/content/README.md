# @plakboek/content

Headless content types, fields, locale-aware entries and revisions for
Plakboek CMS installations: type and field definitions as database rows, a
shared JSONB entry store, per-field validation, revisions, edit locking,
slug and URL-pattern resolution. No admin UI ships here -- building and
authoring content types is a later phase; this package returns the impact
reports and previews that UI warns from.

## Install

```sh
pnpm add @plakboek/content
```

## Status

Under active development in Phase 3 (Content Type & Field Engine). The
package currently exports nothing from its entry point beyond the
real-Postgres integration test harness used to build the rest of the
phase's engine on top of.
