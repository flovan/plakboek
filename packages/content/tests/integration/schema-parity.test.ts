import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIELD_TYPES } from '../../src/field-types/registry.js';
import * as schema from '../../src/schema.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * Proves the hand-written SQL in `0002_content_engine` and the Drizzle
 * mirror in `@plakboek/content`'s `src/schema.ts` describe the same
 * database: every column's type and nullability, every named constraint
 * and index (including the partial unique index's predicate), that the
 * CHECK constraints reject the rows they are meant to reject, that entry
 * slug uniqueness is scoped to (content_type_id, locale, slug) -- letting
 * one slug repeat across locales -- and that the migration applies
 * cleanly, idempotently, and exactly once under two concurrent migrators.
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

/** Every named constraint that `0002_content_engine.ts` declares via
 * `CONSTRAINT <name>` (auto-named primary keys are intentionally excluded
 * -- nothing in the migration names them). */
const EXPECTED_CONSTRAINT_NAMES = [
  'content_types_key_unique',
  'content_types_slug_unique',
  'content_types_revision_mode_check',
  'content_types_revision_mode_presence_check',
  'content_types_singleton_not_routable_check',
  'content_type_fields_content_type_id_fk',
  'content_type_fields_type_key_unique',
  'content_type_fields_field_type_check',
  'content_type_fields_key_check',
  'content_entries_content_type_id_fk',
  'content_entries_locked_by_user_id_fk',
  'content_entries_created_by_user_id_fk',
  'content_entries_updated_by_user_id_fk',
  'content_entries_type_locale_slug_unique',
  'content_entries_group_locale_unique',
  'content_entries_status_check',
  'content_entries_slug_source_check',
  'content_entries_data_object_check',
  'content_entries_scheduled_at_check',
  'content_entries_resolved_path_check',
  'content_entries_lock_pair_check',
  'content_entries_draft_revision_id_fk',
  'content_entries_live_revision_id_fk',
  'entry_revisions_entry_id_fk',
  'entry_revisions_author_id_user_id_fk',
  'entry_revisions_kind_check',
  'content_type_key_history_content_type_id_fk',
  'content_type_key_history_changed_by_user_id_fk',
  'content_field_key_history_content_type_id_fk',
  'content_field_key_history_changed_by_user_id_fk',
  'content_entry_url_history_entry_id_fk',
  'content_entry_url_history_content_type_id_fk',
  'content_entry_url_history_reason_check',
  'content_type_seed_applications_kind_check',
  'content_entry_references_source_entry_id_fk',
  'content_engine_settings_id_check',
  'content_engine_settings_revision_cap_check',
] as const;

/** Every named index `0002_content_engine.ts` creates directly (unique
 * constraints and PKs create their own backing index but are asserted via
 * `EXPECTED_CONSTRAINT_NAMES` instead -- this list is the `CREATE [UNIQUE]
 * INDEX` statements). */
const EXPECTED_INDEX_NAMES = [
  'content_entries_type_locale_status_idx',
  'content_entries_translation_group_idx',
  'content_entries_public_id_idx',
  'content_entries_locale_resolved_path_unique',
  'entry_revisions_entry_kind_created_idx',
  'content_entry_url_history_locale_path_idx',
  'content_entry_references_target_idx',
  'content_field_key_history_field_idx',
] as const;

async function expectSchemaMatchesMigration(db: Db): Promise<void> {
  const tables = Object.values(schema).filter((value) =>
    is(value, PgTable),
  ) as PgTable[];
  const configs = tables.map((table) => getTableConfig(table));
  const tableNames = configs.map((config) => config.name);

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
    WHERE n.nspname = 'public'
      AND con.conname = ANY(${[...EXPECTED_CONSTRAINT_NAMES]})
  `;
  expect(new Set(actualConstraints.map((row) => row.name))).toEqual(
    new Set(EXPECTED_CONSTRAINT_NAMES),
  );

  const actualIndexes = await db.sql<{ name: string }[]>`
    SELECT indexname AS "name" FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY(${[...EXPECTED_INDEX_NAMES]})
  `;
  expect(new Set(actualIndexes.map((row) => row.name))).toEqual(
    new Set(EXPECTED_INDEX_NAMES),
  );

  const [partialIndex] = await db.sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'content_entries_locale_resolved_path_unique'
  `;
  expect(partialIndex?.indexdef.toLowerCase()).toContain('where');
  expect(partialIndex?.indexdef.toLowerCase()).toContain(
    'resolved_path is not null',
  );

  const settingsRows = await db.sql<
    { id: number; revisionCap: number }[]
  >`SELECT id, revision_cap AS "revisionCap" FROM content_engine_settings`;
  expect(settingsRows).toHaveLength(1);
  expect(settingsRows[0]).toMatchObject({ id: 1, revisionCap: 0 });
}

type PgError = { readonly code?: string };

/** Runs a rejecting insert and returns the thrown error's SQLSTATE code, or
 * `undefined` if the insert did not throw. Callers assert on the returned
 * code directly, so the `expect` call lives at each call site. */
async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error instanceof Error ? (error as PgError).code : undefined;
}

async function insertContentType(
  db: Db,
  overrides: {
    readonly singleton?: boolean;
    readonly routable?: boolean;
    readonly revisions?: boolean;
    readonly revisionMode?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  await db.sql`
    INSERT INTO content_types
      (id, key, slug, label_singular, label_plural, routable, singleton,
       revisions, revision_mode, created_at, updated_at)
    VALUES
      (${id}, ${`parityType${suffix}`}, ${`parity-type-${suffix}`},
       'Parity type', 'Parity types',
       ${overrides.routable ?? false}, ${overrides.singleton ?? false},
       ${overrides.revisions ?? false}, ${overrides.revisionMode ?? null},
       now(), now())
  `;
  return id;
}

async function insertContentEntry(
  db: Db,
  contentTypeId: string,
  overrides: {
    readonly translationGroup?: string;
    readonly locale?: string;
    readonly slug?: string | null;
    readonly status?: string;
    readonly scheduledAt?: Date | null;
  } = {},
): Promise<void> {
  await db.sql`
    INSERT INTO content_entries
      (id, content_type_id, translation_group, public_id, locale, slug,
       status, scheduled_at, data, version, created_at, updated_at)
    VALUES
      (${randomUUID()}, ${contentTypeId},
       ${overrides.translationGroup ?? randomUUID()},
       nextval('content_entry_public_id_seq'), ${overrides.locale ?? 'en'},
       ${overrides.slug ?? null}, ${overrides.status ?? 'draft'},
       ${overrides.scheduledAt ?? null}, '{}'::jsonb, 1, now(), now())
  `;
}

describe('schema parity: 0002_content_engine vs @plakboek/content schema.ts', () => {
  describe('migration application', () => {
    it('applies 0001_auth_core then 0002_content_engine, cleanly and idempotently', async () => {
      const testDatabase = await createTestDatabase();
      let handle: Db | undefined;
      try {
        const firstRun = await runMigrations({
          connectionString: testDatabase.connectionString,
        });
        expect(firstRun.applied).toEqual([
          '0001_auth_core',
          '0002_content_engine',
        ]);

        const secondRun = await runMigrations({
          connectionString: testDatabase.connectionString,
        });
        expect(secondRun.applied).toEqual([]);
        expect(secondRun.alreadyApplied).toEqual([
          '0001_auth_core',
          '0002_content_engine',
        ]);

        handle = createDb({ connectionString: testDatabase.connectionString });
        await expectSchemaMatchesMigration(handle);
      } finally {
        if (handle !== undefined) await handle.close();
        await testDatabase.drop();
      }
    });

    it('applies 0002_content_engine exactly once under two concurrent migrators', async () => {
      const testDatabase = await createTestDatabase();
      try {
        const runs = await Promise.all([
          runMigrations({ connectionString: testDatabase.connectionString }),
          runMigrations({ connectionString: testDatabase.connectionString }),
        ]);
        const flattenedApplied = runs.flatMap((run) => run.applied);
        expect(
          flattenedApplied.filter((name) => name === '0002_content_engine'),
        ).toHaveLength(1);
        expect(new Set(flattenedApplied).size).toBe(flattenedApplied.length);
      } finally {
        await testDatabase.drop();
      }
    });
  });

  describe('CHECK constraints and slug uniqueness', () => {
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

    it('rejects a content_entries.status outside the allowed set', async () => {
      const typeId = await insertContentType(handle);
      expect(
        await sqlState(
          insertContentEntry(handle, typeId, { status: 'changed' }),
        ),
      ).toBe('23514');
    });

    it('rejects a content_type_fields.field_type outside the allowed set', async () => {
      const typeId = await insertContentType(handle);
      expect(
        await sqlState(
          handle.sql`
            INSERT INTO content_type_fields
              (id, content_type_id, key, label, field_type, widget, sort_order,
               created_at, updated_at)
            VALUES
              (${randomUUID()}, ${typeId}, 'testField', 'Test field', 'color',
               'text-input', 1, now(), now())
          `,
        ),
      ).toBe('23514');
    });

    // Reads content_type_fields_field_type_check's allowed value set directly
    // out of live Postgres and compares it to FIELD_TYPES. This is the
    // assertion that catches a field type shipping without a matching
    // migration update.
    it('keeps content_type_fields_field_type_check in sync with FIELD_TYPES', async () => {
      const [constraint] = await handle.sql<{ constraintdef: string }[]>`
        SELECT pg_get_constraintdef(con.oid) AS "constraintdef"
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND con.conname = 'content_type_fields_field_type_check'
      `;
      expect(constraint).toBeDefined();

      const constraintDef = constraint?.constraintdef ?? '';
      const allowedValues = new Set(
        [...constraintDef.matchAll(/'([^']*)'::text/g)].map(
          (match) => match[1] ?? '',
        ),
      );
      expect(allowedValues).toEqual(new Set(FIELD_TYPES));
    });

    it('rejects revisions = true with a null revision_mode', async () => {
      expect(
        await sqlState(
          insertContentType(handle, { revisions: true, revisionMode: null }),
        ),
      ).toBe('23514');
    });

    it('rejects a singleton content type that is also routable', async () => {
      expect(
        await sqlState(
          insertContentType(handle, { singleton: true, routable: true }),
        ),
      ).toBe('23514');
    });

    it('rejects a scheduled entry with a null scheduled_at', async () => {
      const typeId = await insertContentType(handle);
      expect(
        await sqlState(
          insertContentEntry(handle, typeId, {
            status: 'scheduled',
            scheduledAt: null,
          }),
        ),
      ).toBe('23514');
    });

    it('scopes slug uniqueness to (content_type_id, locale, slug): one slug in two locales, rejected within one locale', async () => {
      const typeId = await insertContentType(handle);

      await insertContentEntry(handle, typeId, {
        locale: 'en',
        slug: 'hello',
      });
      await insertContentEntry(handle, typeId, {
        locale: 'nl',
        slug: 'hello',
      });

      expect(
        await sqlState(
          insertContentEntry(handle, typeId, { locale: 'en', slug: 'hello' }),
        ),
      ).toBe('23505');
    });
  });
});
