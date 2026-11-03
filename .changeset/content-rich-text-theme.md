---
'@plakboek/content': minor
'@plakboek/pages': minor
---

Rich text is now validated against the registered text theme. `@plakboek/content` adds `registerTextTheme`, `getTextTheme` and `effectiveTextTheme`: every `rich_text` write is held to the registered theme narrowed by the property's `narrow` option, so a heading level, node, mark, palette token or href outside it is refused as invalid. It also ships a `link` field type (`LINK_FIELD_TYPE`, widget `link-picker`) whose value is an address or a page id plus an optional `_blank` target. `@plakboek/pages` keeps data, flags it and never crashes: a rich text value an edit leaves unchanged no longer blocks changes to other properties of its block when the theme was narrowed after it was written, while publishing still refuses it as invalid props.
