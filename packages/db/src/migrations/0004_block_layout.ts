import type { Migration } from '../migrate.js';

/**
 * Block layout storage for the page and block-tree engine: a nullable
 * `layout` jsonb column on `page_blocks` and on `block_revisions`. Section
 * layout (the column ratio preset and vertical alignment) and a block's fill
 * flag live here, never inside `props`, so property validation, upcasters and
 * snapshot prop ordering never see layout keys. Mirrors the Drizzle
 * definitions in `@plakboek/pages`'s `src/schema.ts`.
 *
 * Additive and forward-only: the column is nullable with no default (a
 * metadata-only change in Postgres), existing rows keep their data with a
 * null layout, and each CHECK keeps the column a JSON object whenever it is
 * set. Every statement is existence-guarded so a re-run is safe.
 *
 * Immutable once shipped (checksum-enforced): corrections are a new,
 * higher-numbered migration, never an edit to this string.
 */
export const migration: Migration = {
  name: '0004_block_layout',
  transactional: true,
  sql: `
ALTER TABLE "page_blocks" ADD COLUMN IF NOT EXISTS "layout" jsonb;

ALTER TABLE "block_revisions" ADD COLUMN IF NOT EXISTS "layout" jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'page_blocks_layout_object_check'
  ) THEN
    ALTER TABLE "page_blocks"
      ADD CONSTRAINT "page_blocks_layout_object_check"
      CHECK ("layout" IS NULL OR jsonb_typeof("layout") = 'object');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'block_revisions_layout_object_check'
  ) THEN
    ALTER TABLE "block_revisions"
      ADD CONSTRAINT "block_revisions_layout_object_check"
      CHECK ("layout" IS NULL OR jsonb_typeof("layout") = 'object');
  END IF;
END $$;
`,
};
