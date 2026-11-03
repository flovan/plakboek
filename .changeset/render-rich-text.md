---
'@plakboek/render': minor
---

Rich text now renders through one host-overridable renderer map. `defineTextTheme` resolves the text theme data and merges `renderers` over plain semantic defaults; `<RichText value />` renders a stored document with no wrapper element, so the host's own field element stays the editor's root; `CtaButton` renders the standalone Button block exactly like a call to action inside text. Token colours and sizes render as `var(--color-<token>)` and `var(--text-<token>)`, links render only when their target passes the shared href policy or their page resolves, and adjacent calls to action share one row. A new `onRichTextIssue` hook reports an unknown node or mark once per render by type name. `@plakboek/content` is now a runtime dependency; the root entry imports only its client-safe `./rich-text` subpath.
