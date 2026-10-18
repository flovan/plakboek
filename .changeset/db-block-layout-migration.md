---
'@plakboek/db': minor
---

Add migration `0004_block_layout`: a nullable `layout` jsonb column on `page_blocks` and `block_revisions` for section column ratios and alignment and block fill. Additive and safe to run on existing data.
