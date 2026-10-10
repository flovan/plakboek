---
'@plakboek/render': minor
---

Adds the live side of the edit proxy and a renderer for a page's working tree, for the editor's frame document. `createLiveEdit` returns an `EditProxy` that spreads `data-pk-block`, `data-pk-type`, `data-pk-kind` and `data-pk-label` onto a block's root element (`edit.field(name)` yields `data-pk-field`), with the names exported as `EDIT_ATTRIBUTE` from the root entry. `renderPageTree` renders a `BlockNode[]` through the same block containment the visitor snapshot path uses; in `live` mode a block that renders nothing (unknown type, degraded node, throwing or async component) becomes an inert placeholder marked `data-pk-unavailable`, and `plain` mode renders visitor-identical markup with no `data-pk-*` attribute. `normalizeVisitorPath` and its `VisitorPathResult` type are now exported from the server entry. The visitor snapshot output is unchanged.
