import type { Migration } from '../migrate.js';

/**
 * Keeps the id of the block a revision describes as plain data. A revision's
 * `block_id` is a foreign key with `ON DELETE SET NULL`, so once a block is
 * deleted every revision naming it reads back with a null `block_id` and the
 * identity of the deleted blocks is gone. Restoring a deleted subtree needs
 * that identity: a child's `parent_block_id` names its parent's old id, and
 * the restore has to find which restored block that was. `subject_block_id`
 * carries the same id as `block_id` did when the revision was written, with
 * no foreign key, so it survives the delete.
 *
 * Additive and forward-only: the column is nullable with no default (a
 * metadata-only change in Postgres) and is backfilled from `block_id` for
 * every revision whose block still exists. A revision of an already deleted
 * block stays null; restoring a subtree from such a batch keeps the earlier
 * behaviour. The statements are existence-guarded so a re-run is safe.
 *
 * Immutable once shipped (checksum-enforced): corrections are a new,
 * higher-numbered migration, never an edit to this string.
 */
export const migration: Migration = {
  name: '0005_revision_block_ref',
  transactional: true,
  sql: `
ALTER TABLE "block_revisions" ADD COLUMN IF NOT EXISTS "subject_block_id" uuid;

UPDATE "block_revisions"
  SET "subject_block_id" = "block_id"
  WHERE "subject_block_id" IS NULL AND "block_id" IS NOT NULL;
`,
};
