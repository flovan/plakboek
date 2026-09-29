import type { Migration } from '../migrate.js';

/**
 * The Phase 4 page and block-tree engine schema: hierarchical pages with a
 * materialised, indexed `path`; an adjacency-list `page_blocks` tree with
 * polymorphic `owner_type`/`owner_id` and an explicit `schema_version` from
 * every row's first write; per-block revisions (`block_revisions`); publish
 * and draft snapshots (`page_publications`, holding a `revision_manifest`
 * of `{blockId: revisionId}`); page URL history; and the page-engine
 * settings singleton. Mirrors the Drizzle definitions in `@plakboek/pages`'s
 * `src/schema.ts`.
 *
 * Three deliberate divergences from `0002_content_engine`'s own patterns,
 * recorded here because copying the wrong one would be an easy, silent
 * mistake: `page_blocks.block_type` carries no CHECK constraint enumerating
 * a closed set (block types are a host-extensible registry, D-01, EXT-02 --
 * unlike Phase 3's 16 core-owned field types); `page_blocks.owner_id`
 * carries no foreign key at all (`owner_type` stays polymorphic so Phase
 * 19's `content_type_template`/`repeater_item_template` owners can be added
 * without a destructive migration, D-24); `block_revisions.block_id` is
 * nullable with `ON DELETE SET NULL`, not CASCADE (deleting one block must
 * never delete that block's own revision history, D-27). `page_blocks`'s
 * `sort_order` carries no uniqueness constraint: a permuting sibling
 * rebalance under a non-deferrable unique index can spuriously conflict
 * mid-statement, so sibling-order correctness is enforced by the tree
 * engine and reads always order by `sort_order, id`.
 *
 * Immutable once shipped (checksum-enforced): corrections are a new,
 * higher-numbered migration, never an edit to this string.
 */
export const migration: Migration = {
  name: '0003_page_block_engine',
  transactional: true,
  sql: `
CREATE TABLE IF NOT EXISTS "pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "translation_group" uuid NOT NULL,
  "locale" text NOT NULL,
  "parent_page_id" uuid REFERENCES "pages" ("id") ON DELETE RESTRICT,
  "slug" text NOT NULL,
  "slug_source" text NOT NULL DEFAULT 'generated',
  "path" text NOT NULL,
  "resolved_path" text,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "seo" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "live_publication_id" uuid,
  "locked_by" text,
  "locked_at" timestamp with time zone,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "published_at" timestamp with time zone,
  "first_published_at" timestamp with time zone,
  "scheduled_at" timestamp with time zone,
  "trashed_at" timestamp with time zone,
  CONSTRAINT "pages_locked_by_user_id_fk" FOREIGN KEY ("locked_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "pages_created_by_user_id_fk" FOREIGN KEY ("created_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "pages_updated_by_user_id_fk" FOREIGN KEY ("updated_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "pages_locale_path_unique" UNIQUE ("locale", "path"),
  CONSTRAINT "pages_group_locale_unique" UNIQUE ("translation_group", "locale"),
  CONSTRAINT "pages_status_check"
    CHECK ("status" IN ('draft', 'published', 'scheduled', 'trashed')),
  CONSTRAINT "pages_slug_source_check"
    CHECK ("slug_source" IN ('generated', 'manual')),
  CONSTRAINT "pages_scheduled_at_check"
    CHECK ("status" <> 'scheduled' OR "scheduled_at" IS NOT NULL),
  CONSTRAINT "pages_resolved_path_check"
    CHECK ("resolved_path" IS NULL OR "status" = 'published'),
  CONSTRAINT "pages_lock_pair_check"
    CHECK (("locked_by" IS NULL) = ("locked_at" IS NULL)),
  CONSTRAINT "pages_path_check"
    CHECK ("path" <> '' AND "path" NOT LIKE '/%' AND "path" NOT LIKE '%/')
);

CREATE TABLE IF NOT EXISTS "page_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_type" text NOT NULL,
  "owner_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "parent_block_id" uuid REFERENCES "page_blocks" ("id") ON DELETE CASCADE,
  "block_type" text NOT NULL,
  "props" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "schema_version" integer NOT NULL,
  "depth" integer NOT NULL,
  "sort_order" integer NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "page_blocks_created_by_user_id_fk" FOREIGN KEY ("created_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "page_blocks_updated_by_user_id_fk" FOREIGN KEY ("updated_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "page_blocks_owner_type_check" CHECK ("owner_type" IN ('page')),
  CONSTRAINT "page_blocks_props_object_check"
    CHECK (jsonb_typeof("props") = 'object'),
  CONSTRAINT "page_blocks_schema_version_check" CHECK ("schema_version" >= 1),
  CONSTRAINT "page_blocks_depth_check" CHECK ("depth" >= 0)
);

CREATE TABLE IF NOT EXISTS "block_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "block_id" uuid REFERENCES "page_blocks" ("id") ON DELETE SET NULL,
  "owner_type" text NOT NULL,
  "owner_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "revision_batch_id" uuid NOT NULL,
  "change_type" text NOT NULL,
  "kind" text NOT NULL,
  "block_type" text NOT NULL,
  "parent_block_id" uuid,
  "sort_order" integer NOT NULL,
  "depth" integer NOT NULL,
  "props" jsonb NOT NULL,
  "schema_version" integer NOT NULL,
  "author_id" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "block_revisions_author_id_user_id_fk" FOREIGN KEY ("author_id")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "block_revisions_change_type_check"
    CHECK ("change_type" IN ('create', 'update', 'move', 'delete')),
  CONSTRAINT "block_revisions_kind_check" CHECK ("kind" IN ('save', 'publish')),
  CONSTRAINT "block_revisions_props_object_check"
    CHECK (jsonb_typeof("props") = 'object')
);

CREATE TABLE IF NOT EXISTS "page_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "page_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "is_draft" boolean NOT NULL DEFAULT false,
  "snapshot" jsonb NOT NULL,
  "revision_manifest" jsonb NOT NULL,
  "manifest_hash" text NOT NULL,
  "published_by" text,
  "published_at" timestamp with time zone NOT NULL,
  CONSTRAINT "page_publications_page_id_fk" FOREIGN KEY ("page_id")
    REFERENCES "pages" ("id") ON DELETE CASCADE,
  CONSTRAINT "page_publications_published_by_user_id_fk" FOREIGN KEY ("published_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "page_publications_snapshot_object_check"
    CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "page_publications_manifest_object_check"
    CHECK (jsonb_typeof("revision_manifest") = 'object')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pages_live_publication_id_fk'
  ) THEN
    ALTER TABLE "pages"
      ADD CONSTRAINT "pages_live_publication_id_fk"
      FOREIGN KEY ("live_publication_id") REFERENCES "page_publications" ("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "page_url_history" (
  "id" bigserial PRIMARY KEY,
  "page_id" uuid,
  "translation_group" uuid NOT NULL,
  "locale" text NOT NULL,
  "old_path" text NOT NULL,
  "reason" text NOT NULL,
  "changed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "page_url_history_page_id_fk" FOREIGN KEY ("page_id")
    REFERENCES "pages" ("id") ON DELETE SET NULL,
  CONSTRAINT "page_url_history_reason_check" CHECK (
    "reason" IN ('slug_changed', 'moved', 'pattern_changed', 'unpublished', 'trashed', 'deleted')
  )
);

CREATE TABLE IF NOT EXISTS "page_engine_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "page_edit_locking" boolean NOT NULL DEFAULT true,
  "url_pattern" text NOT NULL DEFAULT '{locale}/{path}',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_engine_settings_id_check" CHECK ("id" = 1)
);

INSERT INTO "page_engine_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

CREATE INDEX IF NOT EXISTS "pages_parent_idx" ON "pages" USING btree ("parent_page_id");
CREATE INDEX IF NOT EXISTS "pages_locale_status_idx" ON "pages" USING btree ("locale", "status");
CREATE INDEX IF NOT EXISTS "pages_translation_group_idx" ON "pages" USING btree ("translation_group");
CREATE INDEX IF NOT EXISTS "pages_locale_path_prefix_idx"
  ON "pages" USING btree ("locale", "path" text_pattern_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "pages_locale_resolved_path_unique"
  ON "pages" USING btree ("locale", "resolved_path")
  WHERE "resolved_path" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "page_blocks_owner_idx"
  ON "page_blocks" USING btree ("owner_type", "owner_id", "locale");
CREATE INDEX IF NOT EXISTS "page_blocks_parent_sort_idx"
  ON "page_blocks" USING btree ("parent_block_id", "sort_order");
CREATE INDEX IF NOT EXISTS "page_blocks_type_version_idx"
  ON "page_blocks" USING btree ("block_type", "schema_version");
CREATE INDEX IF NOT EXISTS "block_revisions_owner_created_idx"
  ON "block_revisions" USING btree ("owner_type", "owner_id", "locale", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "block_revisions_batch_idx"
  ON "block_revisions" USING btree ("revision_batch_id");
CREATE INDEX IF NOT EXISTS "block_revisions_block_idx"
  ON "block_revisions" USING btree ("block_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "page_publications_page_draft_published_idx"
  ON "page_publications" USING btree ("page_id", "is_draft", "published_at" DESC);
CREATE INDEX IF NOT EXISTS "page_url_history_locale_path_idx"
  ON "page_url_history" USING btree ("locale", "old_path");
`,
};
