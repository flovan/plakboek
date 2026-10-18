---
'@plakboek/pages': patch
---

A move or insert that names both neighbours in the wrong order (the "previous" sibling at or after the "next" one) is now refused with `InvalidSiblingReferenceError` (`reason: 'inverted'`) before anything is written. Before, it renumbered the whole sibling list and could store a block with the same `sort_order` as a neighbour, so its place depended on the row id. `InvalidSiblingReferenceError` gains an optional fourth constructor argument and a `reason` field.
