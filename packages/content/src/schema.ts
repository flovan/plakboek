/**
 * Drizzle table definitions for the Phase 3 content engine: content types
 * and their fields as database rows (no dynamic DDL), locale-aware entries
 * with a JSONB `data` column, and the supporting revision, key-history,
 * URL-history, seed-tracking, reference and settings tables. TypeScript
 * properties are camelCase, Postgres columns are snake_case.
 *
 * The SQL that creates these tables ships as `@plakboek/db`'s migration
 * `0002_content_engine`. Migrations are forward-only and checksum-immutable,
 * so a change here is never an edit to that migration: it is a new,
 * higher-numbered migration plus the matching change in this file.
 *
 * `"user"` is a reserved word in Postgres and better-auth's user table. Its
 * columns (`locked_by`, `created_by`, `updated_by`, `changed_by`,
 * `author_id`) carry a foreign key in `0002_content_engine`'s SQL only:
 * `@plakboek/auth` does not export its `user` table from this package's
 * dependency surface, so those columns stay plain `text` here.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { FIELD_TYPES } from './field-types/field-type-ids.js';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** The CHECK constraint's `IN (...)` list, rendered from `FIELD_TYPES`.
 * Every value comes from this package's own frozen tuple, never from a
 * caller, so `sql.raw` below carries no injection surface. A plain
 * interpolation of a JS array through drizzle's `sql` template renders
 * bound parameters, which is wrong for a constraint definition, so the
 * list is built as a literal string instead. */
const FIELD_TYPE_SQL_LIST = FIELD_TYPES.map(
  (fieldType) => `'${fieldType}'`,
).join(', ');

export const contentTypes = pgTable(
  'content_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull(),
    slug: text('slug').notNull(),
    labelSingular: text('label_singular').notNull(),
    labelPlural: text('label_plural').notNull(),
    description: text('description'),
    routable: boolean('routable').notNull().default(false),
    urlPattern: text('url_pattern'),
    singleton: boolean('singleton').notNull().default(false),
    drafts: boolean('drafts').notNull().default(false),
    revisions: boolean('revisions').notNull().default(false),
    revisionMode: text('revision_mode'),
    editLocking: boolean('edit_locking').notNull().default(false),
    seo: boolean('seo').notNull().default(false),
    titleFieldKey: text('title_field_key'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('content_types_key_unique').on(table.key),
    unique('content_types_slug_unique').on(table.slug),
    check(
      'content_types_revision_mode_check',
      sql`${table.revisionMode} IN ('on_publish', 'on_every_save')`,
    ),
    check(
      'content_types_revision_mode_presence_check',
      sql`(${table.revisions} AND ${table.revisionMode} IS NOT NULL) OR (NOT ${table.revisions} AND ${table.revisionMode} IS NULL)`,
    ),
    check(
      'content_types_singleton_not_routable_check',
      sql`NOT (${table.singleton} AND ${table.routable})`,
    ),
  ],
);

export const contentTypeFields = pgTable(
  'content_type_fields',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    contentTypeId: uuid('content_type_id')
      .notNull()
      .references(() => contentTypes.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type').notNull(),
    translatable: boolean('translatable').notNull().default(true),
    required: boolean('required').notNull().default(false),
    options: jsonb('options').notNull().default({}),
    widget: text('widget').notNull(),
    widgetOptions: jsonb('widget_options').notNull().default({}),
    defaultValue: jsonb('default_value'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('content_type_fields_type_key_unique').on(
      table.contentTypeId,
      table.key,
    ),
    check(
      'content_type_fields_field_type_check',
      sql`${table.fieldType} IN (${sql.raw(FIELD_TYPE_SQL_LIST)})`,
    ),
    check(
      'content_type_fields_key_check',
      sql`${table.key} ~ '^[a-z][A-Za-z0-9]{0,63}$'`,
    ),
  ],
);

/** Backs `content_entries.public_id` (TYPE-06's `{id}` URL token): a short
 * number shared by every locale row in one translation group. */
export const contentEntryPublicIdSeq = pgSequence(
  'content_entry_public_id_seq',
);

export const contentEntries = pgTable(
  'content_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    contentTypeId: uuid('content_type_id')
      .notNull()
      .references(() => contentTypes.id, { onDelete: 'restrict' }),
    translationGroup: uuid('translation_group').notNull(),
    publicId: bigint('public_id', { mode: 'number' }).notNull(),
    locale: text('locale').notNull(),
    slug: text('slug'),
    slugSource: text('slug_source'),
    status: text('status').notNull().default('draft'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    seo: jsonb('seo'),
    version: integer('version').notNull().default(1),
    draftRevisionId: uuid('draft_revision_id').references(
      (): AnyPgColumn => entryRevisions.id,
      { onDelete: 'set null' },
    ),
    liveRevisionId: uuid('live_revision_id').references(
      (): AnyPgColumn => entryRevisions.id,
      { onDelete: 'set null' },
    ),
    resolvedPath: text('resolved_path'),
    lockedBy: text('locked_by'),
    lockedAt: timestamptz('locked_at'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    publishedAt: timestamptz('published_at'),
    firstPublishedAt: timestamptz('first_published_at'),
    scheduledAt: timestamptz('scheduled_at'),
    trashedAt: timestamptz('trashed_at'),
  },
  (table) => [
    unique('content_entries_type_locale_slug_unique').on(
      table.contentTypeId,
      table.locale,
      table.slug,
    ),
    unique('content_entries_group_locale_unique').on(
      table.translationGroup,
      table.locale,
    ),
    check(
      'content_entries_status_check',
      sql`${table.status} IN ('draft', 'published', 'scheduled', 'trashed')`,
    ),
    check(
      'content_entries_slug_source_check',
      sql`${table.slugSource} IN ('generated', 'manual')`,
    ),
    check(
      'content_entries_data_object_check',
      sql`jsonb_typeof(${table.data}) = 'object'`,
    ),
    check(
      'content_entries_scheduled_at_check',
      sql`${table.status} <> 'scheduled' OR ${table.scheduledAt} IS NOT NULL`,
    ),
    check(
      'content_entries_resolved_path_check',
      sql`${table.resolvedPath} IS NULL OR ${table.status} = 'published'`,
    ),
    check(
      'content_entries_lock_pair_check',
      sql`(${table.lockedBy} IS NULL) = (${table.lockedAt} IS NULL)`,
    ),
    index('content_entries_type_locale_status_idx').on(
      table.contentTypeId,
      table.locale,
      table.status,
    ),
    index('content_entries_translation_group_idx').on(table.translationGroup),
    index('content_entries_public_id_idx').on(table.publicId),
    uniqueIndex('content_entries_locale_resolved_path_unique')
      .on(table.locale, table.resolvedPath)
      .where(sql`${table.resolvedPath} IS NOT NULL`),
  ],
);

/**
 * Immutable field-value snapshots (D-15, D-17). Append-only: this module
 * defines no update or delete helper for this table.
 */
export const entryRevisions = pgTable(
  'entry_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => contentEntries.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    kind: text('kind').notNull(),
    data: jsonb('data').notNull(),
    fieldIds: jsonb('field_ids').notNull(),
    seo: jsonb('seo'),
    slug: text('slug'),
    authorId: text('author_id'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check(
      'entry_revisions_kind_check',
      sql`${table.kind} IN ('save', 'publish')`,
    ),
    index('entry_revisions_entry_kind_created_idx').on(
      table.entryId,
      table.kind,
      table.createdAt,
    ),
  ],
);

/** Append-only rename history for a content type's `key` (D-09). */
export const contentTypeKeyHistory = pgTable('content_type_key_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  contentTypeId: uuid('content_type_id')
    .notNull()
    .references(() => contentTypes.id, { onDelete: 'cascade' }),
  oldKey: text('old_key'),
  newKey: text('new_key').notNull(),
  changedBy: text('changed_by'),
  changedAt: timestamptz('changed_at').notNull(),
});

/** Append-only rename history for a field's `key` (D-09). `fieldId` carries
 * no foreign key so history outlives a deleted field. */
export const contentFieldKeyHistory = pgTable(
  'content_field_key_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contentTypeId: uuid('content_type_id')
      .notNull()
      .references(() => contentTypes.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull(),
    oldKey: text('old_key'),
    newKey: text('new_key').notNull(),
    changedBy: text('changed_by'),
    changedAt: timestamptz('changed_at').notNull(),
  },
  (table) => [
    index('content_field_key_history_field_idx').on(table.fieldId, table.id),
  ],
);

/** Append-only record of a published entry's resolved URL changing (D-33). */
export const contentEntryUrlHistory = pgTable(
  'content_entry_url_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entryId: uuid('entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    contentTypeId: uuid('content_type_id')
      .notNull()
      .references(() => contentTypes.id, { onDelete: 'cascade' }),
    translationGroup: uuid('translation_group').notNull(),
    locale: text('locale').notNull(),
    oldPath: text('old_path').notNull(),
    reason: text('reason').notNull(),
    changedAt: timestamptz('changed_at').notNull(),
  },
  (table) => [
    check(
      'content_entry_url_history_reason_check',
      sql`${table.reason} IN ('slug_changed', 'pattern_changed', 'unpublished', 'trashed', 'deleted')`,
    ),
    index('content_entry_url_history_locale_path_idx').on(
      table.locale,
      table.oldPath,
    ),
  ],
);

/** Tracks applied `defineContentTypes` seed ids (D-03) so a seed item is
 * never re-applied once created or after an admin edit. */
export const contentTypeSeedApplications = pgTable(
  'content_type_seed_applications',
  {
    seedId: text('seed_id').primaryKey(),
    kind: text('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    appliedAt: timestamptz('applied_at').notNull(),
  },
  (table) => [
    check(
      'content_type_seed_applications_kind_check',
      sql`${table.kind} IN ('type', 'field')`,
    ),
  ],
);

/** Derived reverse-reference index (D-40): "referenced by N entries" is an
 * indexed count instead of a JSONB scan of every entry. */
export const contentEntryReferences = pgTable(
  'content_entry_references',
  {
    sourceEntryId: uuid('source_entry_id')
      .notNull()
      .references(() => contentEntries.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull(),
    targetTranslationGroup: uuid('target_translation_group').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.sourceEntryId,
        table.fieldId,
        table.targetTranslationGroup,
      ],
    }),
    index('content_entry_references_target_idx').on(
      table.targetTranslationGroup,
    ),
  ],
);

/** Single-row project settings (D-14): the draft-save revision cap. */
export const contentEngineSettings = pgTable(
  'content_engine_settings',
  {
    id: smallint('id').primaryKey().default(1),
    revisionCap: integer('revision_cap').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('content_engine_settings_id_check', sql`${table.id} = 1`),
    check(
      'content_engine_settings_revision_cap_check',
      sql`${table.revisionCap} >= 0`,
    ),
  ],
);
