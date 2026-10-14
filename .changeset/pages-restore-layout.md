---
'@plakboek/pages': patch
---

Restoring an `update` revision batch now writes the block's stored layout back (column ratio, alignment, fill) instead of only its props, and the restore revision records the layout that was written. A layout key the current configuration no longer accepts, such as a removed ratio preset, is left out rather than failing the restore. `RestoreBlockPreview` gains an optional `layout` field.
