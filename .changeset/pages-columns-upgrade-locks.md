---
'@plakboek/pages': minor
---

Finish the column model in the engine: `applyBlockEdit` gains a `duplicate` operation (a block's whole subtree copied after it under fresh ids, props, layout and schema versions kept), gives an inserted node its definition's starter children and a new section its first column, and refuses with `SectionColumnRequiredError` any batch that would leave a section without a column. `upgradeSectionColumns` and `upgradeAllSectionColumns` bring existing flat page trees into the column shape without losing data (one revision batch, idempotent, serialised per page), and `resolvePublishedPage` wraps flat published snapshots in a synthetic column on read through `normaliseSnapshotColumns`. `readPageLockView` gives an editor the lock state, the holder's display name and last activity, their own lock's expiry and whether they may take the lock over, and nothing else about the holder.
