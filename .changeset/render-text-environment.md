---
'@plakboek/render': minor
'@plakboek/core': patch
---

Visitor pages render rich text through the host theme and resolve page links to live pages. `createVisitorHandler` takes the installation's `textTheme`, wraps every block's render in the text environment, and resolves every page id held by a rich text link, a call to action, a `link` field or a repeater sub-field in one batch before the synchronous render (none when a page holds no page links). A link to a page that is not live renders as plain text. `renderPageSnapshot`, `renderPageTree` and `renderBlockFragments` accept an optional `text` environment, and the server entry exports `collectPageLinkIds`.
