---
'@plakboek/pages': minor
---

Blocks carry a `layout` stored beside their props: a section's column ratio preset and vertical alignment, and a fill flag on blocks that declare `layout: { fill: true }`. Layout is validated on every write against the built-in column presets (`1`, `1:1`, `2:1`, `1:2`, `1:1:1`, `2:1:1`, `1:2:1`, `1:1:2`, `1:1:1:1`), which a host can narrow or extend with the new `columnPresets` config; equal splits are always allowed and stored as no layout. `insertBlock` and `updateBlockProps` accept an optional `layout`, `BlockRecord` and published snapshot blocks expose it, and revisions record it. Working-tree writes now accept a block whose required property is still empty; publishing still refuses it as `invalid-props`. New `findMissingRequiredProps` and `previewBlockValues` answer what a write would accept without writing. Requires `@plakboek/db` with migration `0004_block_layout`.
