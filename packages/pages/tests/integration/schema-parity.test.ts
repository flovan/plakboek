import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/schema.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * Proves the hand-written SQL in `0003_page_block_engine` and the Drizzle
 * mirror in `@plakboek/pages`'s `src/schema.ts` describe the same database:
 * every column's type and nullability, every named constraint and index
 * (including the two partial/operator-class indexes), that the CHECK
 * constraints reject the rows they are meant to reject, that the migration
 * applies cleanly, idempotently and exactly once under two concurrent
 * migrators, and that this phase's three load-bearing divergences from
 * `0002_content_engine`'s own patterns -- open `block_type`, unFK'd
 * `owner_id`, non-cascading `block_revisions.block_id` -- each hold.
 */

type ColumnShape = {
  readonly table: string;
  readonly column: string;
  readonly type: string;
  readonly notNull: boolean;
};

/** Drizzle's `getSQLType()` reports a column's declared SQL type;
 * `information_schema.columns.udt_name` reports Postgres's short internal
 * name for the same type. This maps the handful that differ. */
const UDT_BY_SQL_TYPE: Readonly<Record<string, string>> = {
  boolean: 'bool',
  integer: 'int4',
  bigint: 'int8',
  bigserial: 'int8',
  smallint: 'int2',
  'timestamp with time zone': 'timestamptz',
};

function udtName(sqlType: string): string {
  return UDT_BY_SQL_TYPE[sqlType] ?? sqlType;
}

function byText(a: string, b: string): number {
  return a.localeCompare(b);
}

function sortColumnShapes(shapes: ColumnShape[]): ColumnShape[] {
  return shapes.toSorted((a, b) =>
    byText(`${a.table}.${a.column}`, `${b.table}.${b.column}`),
  );
}

/** Every named constraint `0003_page_block_engine.ts` produces -- both the
 * ones it names explicitly via `CONSTRAINT <name>` and the ones Postgres
 * auto-names for an inline (unnamed) `REFERENCES` clause
 * (`parent_page_id`, `parent_block_id`, `block_id`), confirmed against a
 * live migrated database. Primary keys are included (E1b-WR-03 in
 * `@plakboek/content`'s own schema-parity test: a query scoped by table,
 * not by this list, makes a dropped primary key detectable too). */
const EXPECTED_CONSTRAINT_NAMES = [
  'block_revisions_author_id_user_id_fk',
  'block_revisions_block_id_fkey',
  'block_revisions_change_type_check',
  'block_revisions_kind_check',
  'block_revisions_pkey',
  'block_revisions_props_object_check',
  'page_blocks_created_by_user_id_fk',
  'page_blocks_depth_check',
  'page_blocks_owner_type_check',
  'page_blocks_parent_block_id_fkey',
  'page_blocks_pkey',
  'page_blocks_props_object_check',
  'page_blocks_schema_version_check',
  'page_blocks_updated_by_user_id_fk',
  'page_engine_settings_id_check',
  'page_engine_settings_pkey',
  'page_publications_manifest_object_check',
  'page_publications_page_id_fk',
  'page_publications_pkey',
  'page_publications_published_by_user_id_fk',
  'page_publications_snapshot_object_check',
  'page_url_history_page_id_fk',
  'page_url_history_pkey',
  'page_url_history_reason_check',
  'pages_created_by_user_id_fk',
  'pages_group_locale_unique',
  'pages_live_publication_id_fk',
  'pages_locale_path_unique',
  'pages_lock_pair_check',
  'pages_locked_by_user_id_fk',
  'pages_parent_page_id_fkey',
  'pages_path_check',
  'pages_pkey',
  'pages_resolved_path_check',
  'pages_scheduled_at_check',
  'pages_slug_source_check',
  'pages_status_check',
  'pages_updated_by_user_id_fk',
] as const;

/** Every named index `0003_page_block_engine.ts` creates directly via
 * `CREATE [UNIQUE] INDEX`. Unique constraints and primary keys create their
 * own backing index but are asserted via `EXPECTED_CONSTRAINT_NAMES`
 * instead (the query below excludes any index sharing a constraint's name),
 * so this list holds only the standalone indexes. */
const EXPECTED_INDEX_NAMES = [
  'block_revisions_batch_idx',
  'block_revisions_block_idx',
  'block_revisions_owner_created_idx',
  'page_blocks_owner_idx',
  'page_blocks_parent_sort_idx',
  'page_blocks_type_version_idx',
  'page_publications_page_draft_published_idx',
  'page_url_history_locale_path_idx',
  'pages_locale_path_prefix_idx',
  'pages_locale_resolved_path_unique',
  'pages_locale_status_idx',
  'pages_parent_idx',
  'pages_translation_group_idx',
] as const;

const SCHEMA_TABLE_NAMES = [
  'pages',
  'page_blocks',
  'block_revisions',
  'page_publications',
  'page_url_history',
  'page_engine_settings',
] as const;

async function expectSchemaMatchesMigration(db: Db): Promise<void> {
  const tables = Object.values(schema).filter((value) =>
    is(value, PgTable),
  ) as PgTable[];
  const configs = tables.map((table) => getTableConfig(table));
  const tableNames = configs.map((config) => config.name);
  expect(new Set(tableNames)).toEqual(new Set(SCHEMA_TABLE_NAMES));

  const expectedColumns = sortColumnShapes(
    configs.flatMap((config) =>
      config.columns.map((column) => ({
        table: config.name,
        column: column.name,
        type: udtName(column.getSQLType()),
        notNull: column.notNull,
      })),
    ),
  );
  const actualColumns = await db.sql<
    { table: string; column: string; type: string; notNull: boolean }[]
  >`
    SELECT table_name AS "table", column_name AS "column",
           udt_name AS "type", (is_nullable = 'NO') AS "notNull"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${tableNames})
  `;
  expect(sortColumnShapes([...actualColumns])).toEqual(expectedColumns);

  const actualConstraints = await db.sql<{ name: string }[]>`
    SELECT con.conname AS "name"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY(${tableNames})
  `;
  expect(new Set(actualConstraints.map((row) => row.name))).toEqual(
    new Set(EXPECTED_CONSTRAINT_NAMES),
  );

  const actualIndexes = await db.sql<{ name: string }[]>`
    SELECT i.indexname AS "name"
    FROM pg_indexes i
    WHERE i.schemaname = 'public' AND i.tablename = ANY(${tableNames})
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class ic ON ic.oid = con.conindid
        JOIN pg_namespace ns ON ns.oid = ic.relnamespace
        WHERE ns.nspname = 'public' AND ic.relname = i.indexname
      )
  `;
  expect(new Set(actualIndexes.map((row) => row.name))).toEqual(
    new Set(EXPECTED_INDEX_NAMES),
  );

  const [resolvedPathIndex] = await db.sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'pages_locale_resolved_path_unique'
  `;
  expect(resolvedPathIndex?.indexdef.toLowerCase()).toContain('where');
  expect(resolvedPathIndex?.indexdef.toLowerCase()).toContain(
    'resolved_path is not null',
  );

  const [pathPrefixIndex] = await db.sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'pages_locale_path_prefix_idx'
  `;
  expect(pathPrefixIndex?.indexdef.toLowerCase()).toContain('text_pattern_ops');

  const settingsRows = await db.sql<
    { id: number; pageEditLocking: boolean; urlPattern: string }[]
  >`
    SELECT id, page_edit_locking AS "pageEditLocking",
           url_pattern AS "urlPattern"
    FROM page_engine_settings
  `;
  expect(settingsRows).toHaveLength(1);
  expect(settingsRows[0]).toMatchObject({
    id: 1,
    pageEditLocking: true,
    urlPattern: '{locale}/{path}',
  });
}

type PgError = { readonly code?: string };

/** Runs a rejecting statement and returns the thrown error's SQLSTATE code,
 * or `undefined` if it did not throw. */
async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error instanceof Error ? (error as PgError).code : undefined;
}

type InsertPageOverrides = {
  readonly id?: string;
  readonly translationGroup?: string;
  readonly locale?: string;
  readonly slug?: string;
  readonly path?: string;
  readonly status?: string;
  readonly scheduledAt?: Date | null;
  readonly resolvedPath?: string | null;
};

async function insertPage(
  db: Db,
  overrides: InsertPageOverrides = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const suffix = id.slice(0, 8);
  await db.sql`
    INSERT INTO pages
      (id, translation_group, locale, slug, slug_source, path, title,
       status, scheduled_at, resolved_path, version, created_at, updated_at)
    VALUES
      (${id}, ${overrides.translationGroup ?? randomUUID()},
       ${overrides.locale ?? 'en'}, ${overrides.slug ?? `page-${suffix}`},
       'generated', ${overrides.path ?? `page-${suffix}`}, 'Parity page',
       ${overrides.status ?? 'draft'}, ${overrides.scheduledAt ?? null},
       ${overrides.resolvedPath ?? null}, 1, now(), now())
  `;
  return id;
}

type InsertBlockOverrides = {
  readonly id?: string;
  readonly ownerType?: string;
  readonly ownerId?: string;
  readonly locale?: string;
  readonly parentBlockId?: string | null;
  readonly blockType?: string;
  readonly props?: unknown;
  readonly schemaVersion?: number;
  readonly depth?: number;
  readonly sortOrder?: number;
};

async function insertPageBlock(
  db: Db,
  overrides: InsertBlockOverrides = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.sql`
    INSERT INTO page_blocks
      (id, owner_type, owner_id, locale, parent_block_id, block_type, props,
       schema_version, depth, sort_order, version, created_at, updated_at)
    VALUES
      (${id}, ${overrides.ownerType ?? 'page'}, ${overrides.ownerId ?? randomUUID()},
       ${overrides.locale ?? 'en'}, ${overrides.parentBlockId ?? null},
       ${overrides.blockType ?? 'hero'},
       ${JSON.stringify(overrides.props ?? {})}::jsonb,
       ${overrides.schemaVersion ?? 1}, ${overrides.depth ?? 0},
       ${overrides.sortOrder ?? 1000}, 1, now(), now())
  `;
  return id;
}

type InsertBlockRevisionOverrides = {
  readonly blockId?: string | null;
  readonly ownerType?: string;
  readonly ownerId?: string;
  readonly locale?: string;
  readonly changeType?: string;
  readonly kind?: string;
  readonly blockType?: string;
  readonly parentBlockId?: string | null;
  readonly sortOrder?: number;
  readonly depth?: number;
  readonly props?: unknown;
  readonly schemaVersion?: number;
};

async function insertBlockRevision(
  db: Db,
  overrides: InsertBlockRevisionOverrides = {},
): Promise<string> {
  const id = randomUUID();
  await db.sql`
    INSERT INTO block_revisions
      (id, block_id, owner_type, owner_id, locale, revision_batch_id,
       change_type, kind, block_type, parent_block_id, sort_order, depth,
       props, schema_version, created_at)
    VALUES
      (${id}, ${overrides.blockId ?? null}, ${overrides.ownerType ?? 'page'},
       ${overrides.ownerId ?? randomUUID()}, ${overrides.locale ?? 'en'},
       ${randomUUID()}, ${overrides.changeType ?? 'create'},
       ${overrides.kind ?? 'save'}, ${overrides.blockType ?? 'hero'},
       ${overrides.parentBlockId ?? null}, ${overrides.sortOrder ?? 1000},
       ${overrides.depth ?? 0}, ${JSON.stringify(overrides.props ?? {})}::jsonb,
       ${overrides.schemaVersion ?? 1}, now())
  `;
  return id;
}

describe('schema parity: 0003_page_block_engine vs @plakboek/pages schema.ts', () => {
  describe('migration application', () => {
    it('applies 0001_auth_core, 0002_content_engine then 0003_page_block_engine, cleanly and idempotently', async () => {
      const testDatabase = await createTestDatabase();
      let handle: Db | undefined;
      try {
        const firstRun = await runMigrations({
          connectionString: testDatabase.connectionString,
        });
        expect(firstRun.applied).toEqual([
          '0001_auth_core',
          '0002_content_engine',
          '0003_page_block_engine',
        ]);

        const secondRun = await runMigrations({
          connectionString: testDatabase.connectionString,
        });
        expect(secondRun.applied).toEqual([]);

        handle = createDb({ connectionString: testDatabase.connectionString });
        await expectSchemaMatchesMigration(handle);
      } finally {
        if (handle !== undefined) await handle.close();
        await testDatabase.drop();
      }
    });

    it('applies 0003_page_block_engine exactly once under two concurrent migrators', async () => {
      const testDatabase = await createTestDatabase();
      try {
        const runs = await Promise.all([
          runMigrations({ connectionString: testDatabase.connectionString }),
          runMigrations({ connectionString: testDatabase.connectionString }),
        ]);
        const flattenedApplied = runs.flatMap((run) => run.applied);
        expect(
          flattenedApplied.filter((name) => name === '0003_page_block_engine'),
        ).toHaveLength(1);
        expect(new Set(flattenedApplied).size).toBe(flattenedApplied.length);
      } finally {
        await testDatabase.drop();
      }
    });
  });

  describe('CHECK constraints and design-choice divergences', () => {
    let testDatabase: TestDatabase;
    let handle: Db;

    beforeAll(async () => {
      testDatabase = await createTestDatabase();
      await runMigrations({ connectionString: testDatabase.connectionString });
      handle = createDb({ connectionString: testDatabase.connectionString });
    });

    afterAll(async () => {
      await handle.close();
      await testDatabase.drop();
    });

    it('rejects a pages.status outside the allowed set', async () => {
      expect(await sqlState(insertPage(handle, { status: 'archived' }))).toBe(
        '23514',
      );
    });

    it('rejects a scheduled page with a null scheduled_at', async () => {
      expect(
        await sqlState(
          insertPage(handle, { status: 'scheduled', scheduledAt: null }),
        ),
      ).toBe('23514');
    });

    it('rejects a resolved_path set while status is draft', async () => {
      expect(
        await sqlState(
          insertPage(handle, { status: 'draft', resolvedPath: '/somewhere' }),
        ),
      ).toBe('23514');
    });

    it('rejects a page_blocks row with owner_type outside ("page")', async () => {
      expect(
        await sqlState(insertPageBlock(handle, { ownerType: 'entry' })),
      ).toBe('23514');
    });

    it('rejects a page_blocks row with schema_version = 0', async () => {
      expect(
        await sqlState(insertPageBlock(handle, { schemaVersion: 0 })),
      ).toBe('23514');
    });

    it('rejects a page_blocks row whose props is a JSON array', async () => {
      const id = randomUUID();
      expect(
        await sqlState(handle.sql`
          INSERT INTO page_blocks
            (id, owner_type, owner_id, locale, block_type, props,
             schema_version, depth, sort_order, version, created_at, updated_at)
          VALUES
            (${id}, 'page', ${randomUUID()}, 'en', 'hero', '[]'::jsonb,
             1, 0, 1000, 1, now(), now())
        `),
      ).toBe('23514');
    });

    it('rejects a block_revisions row with change_type = "rename"', async () => {
      expect(
        await sqlState(insertBlockRevision(handle, { changeType: 'rename' })),
      ).toBe('23514');
    });

    it('rejects a block_revisions row with kind = "autosave"', async () => {
      expect(
        await sqlState(insertBlockRevision(handle, { kind: 'autosave' })),
      ).toBe('23514');
    });

    it('rejects a second page_engine_settings row with id = 2', async () => {
      expect(
        await sqlState(handle.sql`
          INSERT INTO page_engine_settings (id) VALUES (2)
        `),
      ).toBe('23514');
    });

    it('accepts an arbitrary block_type with no migration (host extensibility, EXT-02)', async () => {
      expect(
        await sqlState(
          insertPageBlock(handle, { blockType: 'hostCustomBanner' }),
        ),
      ).toBeUndefined();
    });

    it('carries no FOREIGN KEY on page_blocks.owner_id, and accepts an owner_id matching no pages row', async () => {
      const [row] = await handle.sql<{ hasFk: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
          WHERE con.contype = 'f' AND c.relname = 'page_blocks' AND a.attname = 'owner_id'
        ) AS "hasFk"
      `;
      expect(row?.hasFk).toBe(false);

      let unmatchedOwnerInsertState: string | undefined;
      await handle.sql
        .begin(async (tx) => {
          unmatchedOwnerInsertState = await sqlState(
            tx`
              INSERT INTO page_blocks
                (id, owner_type, owner_id, locale, block_type, props,
                 schema_version, depth, sort_order, version, created_at, updated_at)
              VALUES
                (${randomUUID()}, 'page', ${randomUUID()}, 'en', 'hero', '{}'::jsonb,
                 1, 0, 1000, 1, now(), now())
            `,
          );
          // Roll back so this probe leaves no row behind.
          throw new Error('__rollback_probe__');
        })
        .catch((error: unknown) => {
          if (
            !(error instanceof Error) ||
            error.message !== '__rollback_probe__'
          ) {
            throw error;
          }
        });
      expect(unmatchedOwnerInsertState).toBeUndefined();
    });

    it('gives block_revisions.block_id ON DELETE SET NULL (confdeltype "n"), not CASCADE', async () => {
      const [row] = await handle.sql<{ confdeltype: string }[]>`
        SELECT con.confdeltype AS "confdeltype"
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        WHERE con.contype = 'f' AND c.relname = 'block_revisions'
          AND con.conname = 'block_revisions_block_id_fkey'
      `;
      expect(row?.confdeltype).toBe('n');
    });

    it('leaves a deleted block’s revisions readable, with block_id null and owner/locale intact', async () => {
      const ownerId = randomUUID();
      const blockId = await insertPageBlock(handle, { ownerId });
      await insertBlockRevision(handle, {
        blockId,
        ownerId,
        blockType: 'hero',
      });

      await handle.sql`DELETE FROM page_blocks WHERE id = ${blockId}`;

      const revisions = await handle.sql<
        {
          blockId: string | null;
          ownerType: string;
          ownerId: string;
          locale: string;
        }[]
      >`
        SELECT block_id AS "blockId", owner_type AS "ownerType",
               owner_id AS "ownerId", locale
        FROM block_revisions WHERE owner_id = ${ownerId}
      `;
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.blockId).toBeNull();
      expect(revisions[0]?.ownerType).toBe('page');
      expect(revisions[0]?.ownerId).toBe(ownerId);
      expect(revisions[0]?.locale).toBe('en');
    });

    it('cascades child page_blocks rows on parent delete, while their revisions survive the same way', async () => {
      const ownerId = randomUUID();
      const parentId = await insertPageBlock(handle, { ownerId, depth: 0 });
      const childId = await insertPageBlock(handle, {
        ownerId,
        parentBlockId: parentId,
        depth: 1,
      });
      await insertBlockRevision(handle, {
        blockId: childId,
        ownerId,
        parentBlockId: parentId,
      });

      await handle.sql`DELETE FROM page_blocks WHERE id = ${parentId}`;

      const remainingBlocks = await handle.sql<{ id: string }[]>`
        SELECT id FROM page_blocks WHERE id = ${childId}
      `;
      expect(remainingBlocks).toHaveLength(0);

      const childRevisions = await handle.sql<{ blockId: string | null }[]>`
        SELECT block_id AS "blockId" FROM block_revisions WHERE owner_id = ${ownerId}
          AND block_type = 'hero' AND parent_block_id = ${parentId}
      `;
      expect(childRevisions).toHaveLength(1);
      expect(childRevisions[0]?.blockId).toBeNull();
    });

    it('lets two pages share a path across locales, and rejects a second row with it in the same locale', async () => {
      const group = randomUUID();
      await insertPage(handle, {
        translationGroup: group,
        locale: 'en',
        path: 'about-us',
      });
      await insertPage(handle, {
        translationGroup: randomUUID(),
        locale: 'nl',
        path: 'about-us',
      });

      expect(
        await sqlState(
          insertPage(handle, {
            translationGroup: randomUUID(),
            locale: 'en',
            path: 'about-us',
          }),
        ),
      ).toBe('23505');
    });

    it('page_engine_settings holds exactly one row with page_edit_locking true and the default url_pattern', async () => {
      const rows = await handle.sql<
        { id: number; pageEditLocking: boolean; urlPattern: string }[]
      >`
        SELECT id, page_edit_locking AS "pageEditLocking",
               url_pattern AS "urlPattern"
        FROM page_engine_settings
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 1,
        pageEditLocking: true,
        urlPattern: '{locale}/{path}',
      });
    });
  });
});
