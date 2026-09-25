/**
 * Drizzle table definitions for the Phase 4 page and block-tree engine:
 * hierarchical pages with a materialised path, the block adjacency list
 * (`page_blocks`), per-block revisions, publish/draft snapshots, page URL
 * history and the page-engine settings singleton. TypeScript properties are
 * camelCase, Postgres columns are snake_case.
 *
 * The SQL that creates these tables ships as `@plakboek/db`'s migration
 * `0003_page_block_engine`. Migrations are forward-only and
 * checksum-immutable, so a change here is never an edit to that migration:
 * it is a new, higher-numbered migration plus the matching change in this
 * file.
 *
 * `"user"` is a reserved word in Postgres and better-auth's user table. Its
 * columns (`locked_by`, `created_by`, `updated_by`, `author_id`,
 * `published_by`) carry a foreign key in `0003_page_block_engine`'s SQL
 * only: `@plakboek/auth` does not export its `user` table from this
 * package's dependency surface, so those columns stay plain `text` here.
 *
 * Three load-bearing divergences from `@plakboek/content`'s
 * `0002_content_engine` patterns (04-RESEARCH.md Pitfalls 1-3): `block_type`
 * carries no CHECK enum (host-extensible, unlike Phase 3's 16 closed field
 * types); `owner_id` carries no foreign key at all (polymorphic, so Phase
 * 19 can widen `owner_type` without a destructive migration); `block_id` on
 * `block_revisions` is nullable with `ON DELETE SET NULL`, not CASCADE, so
 * deleting one block never deletes that block's own history.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    translationGroup: uuid('translation_group').notNull(),
    locale: text('locale').notNull(),
    parentPageId: uuid('parent_page_id').references(
      (): AnyPgColumn => pages.id,
      { onDelete: 'restrict' },
    ),
    slug: text('slug').notNull(),
    slugSource: text('slug_source').notNull().default('generated'),
    path: text('path').notNull(),
    resolvedPath: text('resolved_path'),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    seo: jsonb('seo'),
    version: integer('version').notNull().default(1),
    livePublicationId: uuid('live_publication_id').references(
      (): AnyPgColumn => pagePublications.id,
      { onDelete: 'set null' },
    ),
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
    unique('pages_locale_path_unique').on(table.locale, table.path),
    unique('pages_group_locale_unique').on(
      table.translationGroup,
      table.locale,
    ),
    check(
      'pages_status_check',
      sql`${table.status} IN ('draft', 'published', 'scheduled', 'trashed')`,
    ),
    check(
      'pages_slug_source_check',
      sql`${table.slugSource} IN ('generated', 'manual')`,
    ),
    check(
      'pages_scheduled_at_check',
      sql`${table.status} <> 'scheduled' OR ${table.scheduledAt} IS NOT NULL`,
    ),
    check(
      'pages_resolved_path_check',
      sql`${table.resolvedPath} IS NULL OR ${table.status} = 'published'`,
    ),
    check(
      'pages_lock_pair_check',
      sql`(${table.lockedBy} IS NULL) = (${table.lockedAt} IS NULL)`,
    ),
    check(
      'pages_path_check',
      sql`${table.path} <> '' AND ${table.path} NOT LIKE '/%' AND ${table.path} NOT LIKE '%/'`,
    ),
    index('pages_parent_idx').on(table.parentPageId),
    index('pages_locale_status_idx').on(table.locale, table.status),
    index('pages_translation_group_idx').on(table.translationGroup),
    index('pages_locale_path_prefix_idx').on(
      table.locale,
      table.path.op('text_pattern_ops'),
    ),
    uniqueIndex('pages_locale_resolved_path_unique')
      .on(table.locale, table.resolvedPath)
      .where(sql`${table.resolvedPath} IS NOT NULL`),
  ],
);

export const pageBlocks = pgTable(
  'page_blocks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    locale: text('locale').notNull(),
    parentBlockId: uuid('parent_block_id').references(
      (): AnyPgColumn => pageBlocks.id,
      { onDelete: 'cascade' },
    ),
    blockType: text('block_type').notNull(),
    props: jsonb('props')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    schemaVersion: integer('schema_version').notNull(),
    depth: integer('depth').notNull(),
    sortOrder: integer('sort_order').notNull(),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    check('page_blocks_owner_type_check', sql`${table.ownerType} IN ('page')`),
    check(
      'page_blocks_props_object_check',
      sql`jsonb_typeof(${table.props}) = 'object'`,
    ),
    check('page_blocks_schema_version_check', sql`${table.schemaVersion} >= 1`),
    check('page_blocks_depth_check', sql`${table.depth} >= 0`),
    index('page_blocks_owner_idx').on(
      table.ownerType,
      table.ownerId,
      table.locale,
    ),
    index('page_blocks_parent_sort_idx').on(
      table.parentBlockId,
      table.sortOrder,
    ),
    index('page_blocks_type_version_idx').on(
      table.blockType,
      table.schemaVersion,
    ),
  ],
);

export const blockRevisions = pgTable(
  'block_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    blockId: uuid('block_id').references((): AnyPgColumn => pageBlocks.id, {
      onDelete: 'set null',
    }),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    locale: text('locale').notNull(),
    revisionBatchId: uuid('revision_batch_id').notNull(),
    changeType: text('change_type').notNull(),
    kind: text('kind').notNull(),
    blockType: text('block_type').notNull(),
    parentBlockId: uuid('parent_block_id'),
    sortOrder: integer('sort_order').notNull(),
    depth: integer('depth').notNull(),
    props: jsonb('props').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    authorId: text('author_id'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check(
      'block_revisions_change_type_check',
      sql`${table.changeType} IN ('create', 'update', 'move', 'delete')`,
    ),
    check(
      'block_revisions_kind_check',
      sql`${table.kind} IN ('save', 'publish')`,
    ),
    check(
      'block_revisions_props_object_check',
      sql`jsonb_typeof(${table.props}) = 'object'`,
    ),
    index('block_revisions_owner_created_idx').on(
      table.ownerType,
      table.ownerId,
      table.locale,
      table.createdAt.desc(),
    ),
    index('block_revisions_batch_idx').on(table.revisionBatchId),
    index('block_revisions_block_idx').on(
      table.blockId,
      table.createdAt.desc(),
    ),
  ],
);

export const pagePublications = pgTable(
  'page_publications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    isDraft: boolean('is_draft').notNull().default(false),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    revisionManifest: jsonb('revision_manifest')
      .$type<Record<string, string>>()
      .notNull(),
    manifestHash: text('manifest_hash').notNull(),
    publishedBy: text('published_by'),
    publishedAt: timestamptz('published_at').notNull(),
  },
  (table) => [
    check(
      'page_publications_snapshot_object_check',
      sql`jsonb_typeof(${table.snapshot}) = 'object'`,
    ),
    check(
      'page_publications_manifest_object_check',
      sql`jsonb_typeof(${table.revisionManifest}) = 'object'`,
    ),
    index('page_publications_page_draft_published_idx').on(
      table.pageId,
      table.isDraft,
      table.publishedAt.desc(),
    ),
  ],
);

/** Append-only record of a published page's resolved URL changing, mirrors
 * `@plakboek/content`'s `content_entry_url_history` (D-21, D-22). Not read
 * or written until plan 04-10. */
export const pageUrlHistory = pgTable(
  'page_url_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    pageId: uuid('page_id').references(() => pages.id, {
      onDelete: 'set null',
    }),
    translationGroup: uuid('translation_group').notNull(),
    locale: text('locale').notNull(),
    oldPath: text('old_path').notNull(),
    reason: text('reason').notNull(),
    changedAt: timestamptz('changed_at').notNull(),
  },
  (table) => [
    check(
      'page_url_history_reason_check',
      sql`${table.reason} IN ('slug_changed', 'moved', 'pattern_changed', 'unpublished', 'trashed', 'deleted')`,
    ),
    index('page_url_history_locale_path_idx').on(table.locale, table.oldPath),
  ],
);

/** Single-row project settings (D-40): the project-wide page edit-lock
 * toggle and the URL-pattern setting. Not read or written until plan
 * 04-08/04-10. */
export const pageEngineSettings = pgTable(
  'page_engine_settings',
  {
    id: smallint('id').primaryKey().default(1),
    pageEditLocking: boolean('page_edit_locking').notNull().default(true),
    urlPattern: text('url_pattern').notNull().default('{locale}/{path}'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [check('page_engine_settings_id_check', sql`${table.id} = 1`)],
);
