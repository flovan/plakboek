import type { Migration } from '../migrate.js';

/**
 * The Phase 3 content engine schema: content types and their fields as
 * database rows (no dynamic DDL -- adding a field always writes a row, never
 * an `ALTER TABLE`), locale-aware entries with a JSONB `data` column, and
 * the supporting revision, key-history, URL-history, seed-tracking,
 * reference and settings tables. Mirrors the Drizzle definitions in
 * `@plakboek/content`'s `src/schema.ts`.
 *
 * The `{id}` URL token (TYPE-06) resolves to `content_entries.public_id`, a
 * short number shared by every locale row in one translation group (the
 * "group-number" persistence shape locked in 03-01-SUMMARY.md); row ids
 * stay UUIDs internally.
 *
 * Immutable once shipped (checksum-enforced): corrections are a new,
 * higher-numbered migration, never an edit to this string.
 */
export const migration: Migration = {
  name: '0002_content_engine',
  transactional: true,
  sql: `
CREATE TABLE IF NOT EXISTS "content_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" text NOT NULL,
  "slug" text NOT NULL,
  "label_singular" text NOT NULL,
  "label_plural" text NOT NULL,
  "description" text,
  "routable" boolean NOT NULL DEFAULT false,
  "url_pattern" text,
  "singleton" boolean NOT NULL DEFAULT false,
  "drafts" boolean NOT NULL DEFAULT false,
  "revisions" boolean NOT NULL DEFAULT false,
  "revision_mode" text,
  "edit_locking" boolean NOT NULL DEFAULT false,
  "seo" boolean NOT NULL DEFAULT false,
  "title_field_key" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "content_types_key_unique" UNIQUE ("key"),
  CONSTRAINT "content_types_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "content_types_revision_mode_check"
    CHECK ("revision_mode" IN ('on_publish', 'on_every_save')),
  CONSTRAINT "content_types_revision_mode_presence_check"
    CHECK (
      ("revisions" AND "revision_mode" IS NOT NULL)
      OR (NOT "revisions" AND "revision_mode" IS NULL)
    ),
  CONSTRAINT "content_types_singleton_not_routable_check"
    CHECK (NOT ("singleton" AND "routable"))
);

CREATE TABLE IF NOT EXISTS "content_type_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "content_type_id" uuid NOT NULL,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "field_type" text NOT NULL,
  "translatable" boolean NOT NULL DEFAULT true,
  "required" boolean NOT NULL DEFAULT false,
  "options" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "widget" text NOT NULL,
  "widget_options" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "default_value" jsonb,
  "sort_order" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "content_type_fields_content_type_id_fk" FOREIGN KEY ("content_type_id")
    REFERENCES "content_types" ("id") ON DELETE CASCADE,
  CONSTRAINT "content_type_fields_type_key_unique" UNIQUE ("content_type_id", "key"),
  CONSTRAINT "content_type_fields_field_type_check" CHECK (
    "field_type" IN (
      'short_text', 'long_text', 'rich_text', 'number', 'integer', 'boolean',
      'date_time', 'select', 'multi_select', 'image', 'file', 'reference',
      'json', 'slug', 'url', 'repeater'
    )
  ),
  CONSTRAINT "content_type_fields_key_check"
    CHECK ("key" ~ '^[a-z][A-Za-z0-9]{0,63}$')
);

CREATE SEQUENCE IF NOT EXISTS "content_entry_public_id_seq";

CREATE TABLE IF NOT EXISTS "content_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "content_type_id" uuid NOT NULL,
  "translation_group" uuid NOT NULL,
  "public_id" bigint NOT NULL,
  "locale" text NOT NULL,
  "slug" text,
  "slug_source" text,
  "status" text NOT NULL DEFAULT 'draft',
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "seo" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "draft_revision_id" uuid,
  "live_revision_id" uuid,
  "resolved_path" text,
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
  CONSTRAINT "content_entries_content_type_id_fk" FOREIGN KEY ("content_type_id")
    REFERENCES "content_types" ("id") ON DELETE RESTRICT,
  CONSTRAINT "content_entries_locked_by_user_id_fk" FOREIGN KEY ("locked_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "content_entries_created_by_user_id_fk" FOREIGN KEY ("created_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "content_entries_updated_by_user_id_fk" FOREIGN KEY ("updated_by")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "content_entries_type_locale_slug_unique"
    UNIQUE ("content_type_id", "locale", "slug"),
  CONSTRAINT "content_entries_group_locale_unique"
    UNIQUE ("translation_group", "locale"),
  CONSTRAINT "content_entries_status_check"
    CHECK ("status" IN ('draft', 'published', 'scheduled', 'trashed')),
  CONSTRAINT "content_entries_slug_source_check"
    CHECK ("slug_source" IN ('generated', 'manual')),
  CONSTRAINT "content_entries_data_object_check"
    CHECK (jsonb_typeof("data") = 'object'),
  CONSTRAINT "content_entries_scheduled_at_check"
    CHECK ("status" <> 'scheduled' OR "scheduled_at" IS NOT NULL),
  CONSTRAINT "content_entries_resolved_path_check"
    CHECK ("resolved_path" IS NULL OR "status" = 'published'),
  CONSTRAINT "content_entries_lock_pair_check"
    CHECK (("locked_by" IS NULL) = ("locked_at" IS NULL))
);

CREATE TABLE IF NOT EXISTS "entry_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entry_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "kind" text NOT NULL,
  "data" jsonb NOT NULL,
  "field_ids" jsonb NOT NULL,
  "seo" jsonb,
  "slug" text,
  "author_id" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "entry_revisions_entry_id_fk" FOREIGN KEY ("entry_id")
    REFERENCES "content_entries" ("id") ON DELETE CASCADE,
  CONSTRAINT "entry_revisions_author_id_user_id_fk" FOREIGN KEY ("author_id")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "entry_revisions_kind_check" CHECK ("kind" IN ('save', 'publish'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_entries_draft_revision_id_fk'
  ) THEN
    ALTER TABLE "content_entries"
      ADD CONSTRAINT "content_entries_draft_revision_id_fk"
      FOREIGN KEY ("draft_revision_id") REFERENCES "entry_revisions" ("id") ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_entries_live_revision_id_fk'
  ) THEN
    ALTER TABLE "content_entries"
      ADD CONSTRAINT "content_entries_live_revision_id_fk"
      FOREIGN KEY ("live_revision_id") REFERENCES "entry_revisions" ("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "content_type_key_history" (
  "id" bigserial PRIMARY KEY,
  "content_type_id" uuid NOT NULL,
  "old_key" text,
  "new_key" text NOT NULL,
  "changed_by" text,
  "changed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "content_type_key_history_content_type_id_fk" FOREIGN KEY ("content_type_id")
    REFERENCES "content_types" ("id") ON DELETE CASCADE,
  CONSTRAINT "content_type_key_history_changed_by_user_id_fk" FOREIGN KEY ("changed_by")
    REFERENCES "user" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "content_field_key_history" (
  "id" bigserial PRIMARY KEY,
  "content_type_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "old_key" text,
  "new_key" text NOT NULL,
  "changed_by" text,
  "changed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "content_field_key_history_content_type_id_fk" FOREIGN KEY ("content_type_id")
    REFERENCES "content_types" ("id") ON DELETE CASCADE,
  CONSTRAINT "content_field_key_history_changed_by_user_id_fk" FOREIGN KEY ("changed_by")
    REFERENCES "user" ("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "content_entry_url_history" (
  "id" bigserial PRIMARY KEY,
  "entry_id" uuid,
  "content_type_id" uuid NOT NULL,
  "translation_group" uuid NOT NULL,
  "locale" text NOT NULL,
  "old_path" text NOT NULL,
  "reason" text NOT NULL,
  "changed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "content_entry_url_history_entry_id_fk" FOREIGN KEY ("entry_id")
    REFERENCES "content_entries" ("id") ON DELETE SET NULL,
  CONSTRAINT "content_entry_url_history_content_type_id_fk" FOREIGN KEY ("content_type_id")
    REFERENCES "content_types" ("id") ON DELETE CASCADE,
  CONSTRAINT "content_entry_url_history_reason_check" CHECK (
    "reason" IN ('slug_changed', 'pattern_changed', 'unpublished', 'trashed', 'deleted')
  )
);

CREATE TABLE IF NOT EXISTS "content_type_seed_applications" (
  "seed_id" text PRIMARY KEY,
  "kind" text NOT NULL,
  "target_id" uuid NOT NULL,
  "applied_at" timestamp with time zone NOT NULL,
  CONSTRAINT "content_type_seed_applications_kind_check" CHECK ("kind" IN ('type', 'field'))
);

CREATE TABLE IF NOT EXISTS "content_entry_references" (
  "source_entry_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "target_translation_group" uuid NOT NULL,
  PRIMARY KEY ("source_entry_id", "field_id", "target_translation_group"),
  CONSTRAINT "content_entry_references_source_entry_id_fk" FOREIGN KEY ("source_entry_id")
    REFERENCES "content_entries" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "content_engine_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "revision_cap" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "content_engine_settings_id_check" CHECK ("id" = 1),
  CONSTRAINT "content_engine_settings_revision_cap_check" CHECK ("revision_cap" >= 0)
);

INSERT INTO "content_engine_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

CREATE INDEX IF NOT EXISTS "content_entries_type_locale_status_idx"
  ON "content_entries" USING btree ("content_type_id", "locale", "status");
CREATE INDEX IF NOT EXISTS "content_entries_translation_group_idx"
  ON "content_entries" USING btree ("translation_group");
CREATE INDEX IF NOT EXISTS "content_entries_public_id_idx"
  ON "content_entries" USING btree ("public_id");
CREATE UNIQUE INDEX IF NOT EXISTS "content_entries_locale_resolved_path_unique"
  ON "content_entries" USING btree ("locale", "resolved_path")
  WHERE "resolved_path" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "entry_revisions_entry_kind_created_idx"
  ON "entry_revisions" USING btree ("entry_id", "kind", "created_at");
CREATE INDEX IF NOT EXISTS "content_entry_url_history_locale_path_idx"
  ON "content_entry_url_history" USING btree ("locale", "old_path");
CREATE INDEX IF NOT EXISTS "content_entry_references_target_idx"
  ON "content_entry_references" USING btree ("target_translation_group");
CREATE INDEX IF NOT EXISTS "content_field_key_history_field_idx"
  ON "content_field_key_history" USING btree ("field_id", "id");
`,
};
