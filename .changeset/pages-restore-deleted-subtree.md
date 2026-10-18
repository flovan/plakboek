---
'@plakboek/pages': patch
'@plakboek/db': minor
---

Restoring a revision batch that deleted a whole subtree (a section with its columns and blocks) now works: each re-created block is re-parented to the new id of its re-created parent, where before every child past the root was refused with `RestoreParentNotFoundError` and nothing could be restored. A re-created block takes its depth from where it lands. Migration `0005_revision_block_ref` adds `block_revisions.subject_block_id`, the revised block's id kept as plain data after the block row is deleted (`block_id` is nulled by the foreign key), and backfills it for revisions whose block still exists. A batch that deleted a subtree before this migration cannot be restored below its root, as before.
