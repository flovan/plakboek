---
'@plakboek/pages': patch
---

A section always keeps a column on every write path, not only in `applyBlockEdit`: `moveBlock` and `deleteBlock` refuse with `SectionColumnRequiredError` when they would take a section's last column away, and so does `restoreRevisionBatch` when a restored move would. `insertBlock` is documented as the single-block writer that adds no starter column (the column upgrade and `applyBlockEdit` do that).
