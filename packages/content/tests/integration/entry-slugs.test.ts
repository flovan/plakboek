import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import { createEntry } from '../../src/entries.js';
import { contentEntries } from '../../src/schema.js';
import {
  InvalidSlugError,
  SlugConflictError,
  SlugGenerationError,
  assertEntrySlugAvailable,
  generateUniqueEntrySlug,
} from '../../src/slug.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('entry slug generation and availability (D-28)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: ContentDeps;
  let actor: AuditActor;
  let contentTypeId: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const config = defineContentConfig({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'UTC',
    });
    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    deps = { db, recorder, resolver, config };

    const type = await createContentType(deps, actor, {
      key: 'article',
      labelSingular: 'Article',
      labelPlural: 'Articles',
    });
    contentTypeId = type.id;
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  async function createFixtureEntry(
    locale: string,
    slug: string | null,
  ): Promise<string> {
    const entry = await createEntry(deps, actor, {
      contentTypeKey: 'article',
      locale,
      data: {},
    });
    if (slug !== null) {
      await handle.sql`UPDATE content_entries SET slug = ${slug} WHERE id = ${entry.id}`;
    }
    return entry.id;
  }

  it('returns the base unchanged when it is free', async () => {
    const slug = await db.transaction((tx) =>
      generateUniqueEntrySlug(tx, {
        contentTypeId,
        locale: 'nl',
        base: 'first-post',
      }),
    );
    expect(slug).toBe('first-post');
  });

  it('suffixes with -2, then -3, as clashes accumulate, scoped to (type, locale)', async () => {
    const helloEnId = await createFixtureEntry('en', 'hello');

    const firstClash = await db.transaction((tx) =>
      generateUniqueEntrySlug(tx, {
        contentTypeId,
        locale: 'en',
        base: 'hello',
      }),
    );
    expect(firstClash).toBe('hello-2');

    const hello2EnId = await createFixtureEntry('en', 'hello-2');

    const secondClash = await db.transaction((tx) =>
      generateUniqueEntrySlug(tx, {
        contentTypeId,
        locale: 'en',
        base: 'hello',
      }),
    );
    expect(secondClash).toBe('hello-3');

    // Same base is free in a different locale -- one slug can repeat across locales.
    const nlSlug = await db.transaction((tx) =>
      generateUniqueEntrySlug(tx, {
        contentTypeId,
        locale: 'nl',
        base: 'hello',
      }),
    );
    expect(nlSlug).toBe('hello');

    await handle.sql`DELETE FROM content_entries WHERE id IN (${helloEnId}, ${hello2EnId})`;
  });

  it('truncates a 200-character base so a suffixed clash never exceeds SLUG_MAX_LENGTH', async () => {
    const longBase = 'a'.repeat(200);
    const longId = await createFixtureEntry('en', longBase);

    const suffixed = await db.transaction((tx) =>
      generateUniqueEntrySlug(tx, {
        contentTypeId,
        locale: 'en',
        base: longBase,
      }),
    );
    expect(suffixed.length).toBe(200);
    expect(suffixed.endsWith('-2')).toBe(true);

    await handle.sql`DELETE FROM content_entries WHERE id = ${longId}`;
  });

  it('throws SlugGenerationError when the base normalises to nothing', async () => {
    await expect(
      db.transaction((tx) =>
        generateUniqueEntrySlug(tx, {
          contentTypeId,
          locale: 'en',
          base: '!!!',
        }),
      ),
    ).rejects.toBeInstanceOf(SlugGenerationError);
  });

  it('assertEntrySlugAvailable rejects a taken slug, passes for its own holder, and rejects a non-normalized slug with a suggestion', async () => {
    const holderId = await createFixtureEntry('en', 'taken-slug');

    await expect(
      db.transaction((tx) =>
        assertEntrySlugAvailable(tx, {
          contentTypeId,
          locale: 'en',
          slug: 'taken-slug',
        }),
      ),
    ).rejects.toBeInstanceOf(SlugConflictError);

    await expect(
      db.transaction((tx) =>
        assertEntrySlugAvailable(tx, {
          contentTypeId,
          locale: 'en',
          slug: 'taken-slug',
          excludeEntryId: holderId,
        }),
      ),
    ).resolves.toBeUndefined();

    const invalidError: unknown = await db
      .transaction((tx) =>
        assertEntrySlugAvailable(tx, {
          contentTypeId,
          locale: 'en',
          slug: 'Taken-Slug',
        }),
      )
      .catch((caught: unknown) => caught);
    expect(invalidError).toBeInstanceOf(InvalidSlugError);
    expect((invalidError as InvalidSlugError).suggestion).toBe('taken-slug');

    await handle.sql`DELETE FROM content_entries WHERE id = ${holderId}`;
  });

  it('concurrent transactions generating from the same base never collide (discrimination-checked)', async () => {
    // Two racers alone rarely overlap on a fast local connection (the
    // full BEGIN/SELECT/INSERT/COMMIT round trip is short enough that the
    // two transactions are usually serialized by network timing before
    // either ever sees the other's uncommitted work). Eight racers make
    // the collision window reliably observable -- and, per D-28, the
    // guarantee it proves ("two transactions racing the same base obtain
    // two different slugs") holds for any two of them.
    const RACER_COUNT = 8;

    async function generateAndInsertRaceSlug(): Promise<string> {
      return await db.transaction(async (tx) => {
        const slug = await generateUniqueEntrySlug(tx, {
          contentTypeId,
          locale: 'en',
          base: 'race',
        });
        await tx.insert(contentEntries).values({
          contentTypeId,
          translationGroup: randomUUID(),
          publicId: sql`nextval('content_entry_public_id_seq')`,
          locale: 'en',
          slug,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return slug;
      });
    }

    const results = await Promise.all(
      Array.from({ length: RACER_COUNT }, () => generateAndInsertRaceSlug()),
    );

    expect(results).toHaveLength(RACER_COUNT);
    expect(new Set(results).size).toBe(RACER_COUNT);
    expect(results).toContain('race');

    await handle.sql`DELETE FROM content_entries WHERE content_type_id = ${contentTypeId} AND slug LIKE ${'race%'}`;
  });
});
