---
'@plakboek/pages': minor
---

Blocks gain a third kind, `column`. When a registry holds a column kind, a section accepts only columns and a column sits only directly under a section; a block under a column is placement-checked against the column's section, so host sections never declare `column`, and columns never count toward the section nesting cap. A registry without a column kind behaves exactly as before. Block declarations can also set `layout: { fill: true }` and `starterChildren`, validated when the blocks are defined. The new pure `checkPlacement` returns the refusal reason or `null` for a proposed placement, so an editor can draw legal drop targets from the same rule every insert, move and restore enforces.
