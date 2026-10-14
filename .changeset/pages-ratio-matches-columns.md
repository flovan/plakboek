---
'@plakboek/pages': patch
---

`applyBlockEdit` now refuses a batch that ends with a section whose stored column ratio names a different number of terms than the section has columns (a ratio for two columns on a one-column section), with `BlockLayoutValidationError` for `columns`. It checks the sections the batch created, gave a layout, or whose columns it added, copied, moved or deleted; a batch that changes a section's column count must put it back on the equal split (no ratio) in the same batch, as the editor does.
