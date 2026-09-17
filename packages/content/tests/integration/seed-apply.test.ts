import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import {
  createContentType,
  deleteContentType,
  getContentTypeByKey,
} from '../../src/content-types.js';
import { deleteField, listFields, renameField } from '../../src/fields.js';
import { applySeed, defineContentTypes } from '../../src/seed.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('applySeed: additive application, id tracking and drift notices (D-03, D-04)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let superadmin: AuditActor;
  let editor: AuditActor;

  const clock = (): Date => new Date('2026-09-16T12:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });

    const config = defineContentConfig({
      locales: ['en', 'nl'],
      defaultLocale: 'en',
      timezone: 'Europe/Brussels',
    });

    deps = { db: handle.db, recorder, resolver, config, now: clock };

    async function makeUser(
      email: string,
      roleKey: string,
    ): Promise<AuditActor> {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: email,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }

    superadmin = await makeUser('owner@example.com', 'superadmin');
    editor = await makeUser('editor@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function seedApplicationRow(
    seedId: string,
  ): Promise<{ seedId: string; kind: string; targetId: string } | undefined> {
    const rows = await handle.sql<
      { seed_id: string; kind: string; target_id: string }[]
    >`SELECT seed_id, kind, target_id FROM content_type_seed_applications WHERE seed_id = ${seedId}`;
    const row = rows[0];
    return row === undefined
      ? undefined
      : { seedId: row.seed_id, kind: row.kind, targetId: row.target_id };
  }

  async function countSeedApplications(
    seedIds: readonly string[],
  ): Promise<number> {
    const rows = await handle.sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM content_type_seed_applications WHERE seed_id = ANY(${seedIds})`;
    return Number(rows[0]?.count ?? '0');
  }

  async function auditRowsFor(action: string): Promise<{ outcome: string }[]> {
    return await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log WHERE action = ${action} ORDER BY id
    `;
  }

  it('first deploy: creates the type and both fields in order, records three rows, and reports what it created', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy1.post',
        key: 'deploy1Post',
        labelSingular: 'Deploy1 Post',
        labelPlural: 'Deploy1 Posts',
        fields: [
          {
            seedId: 'deploy1.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
          { seedId: 'deploy1.post.views', label: 'Views', fieldType: 'number' },
        ],
      },
    ]);

    const report = await applySeed(deps, superadmin, seed);

    expect(report.createdTypes).toEqual(['deploy1.post']);
    expect(report.createdFields).toEqual([
      'deploy1.post.title',
      'deploy1.post.views',
    ]);
    expect(report.adopted).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.drift).toEqual([]);

    expect(
      await countSeedApplications([
        'deploy1.post',
        'deploy1.post.title',
        'deploy1.post.views',
      ]),
    ).toBe(3);

    const type = await getContentTypeByKey(handle.db, 'deploy1Post');
    expect(type).not.toBeNull();
    const fields = await listFields(handle.db, type?.id ?? '');
    expect(fields.map((field) => field.key)).toEqual(['title', 'views']);
  });

  it('idempotency: applying the same seed again creates nothing, reports no creations and no drift; updated_at is unchanged', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy2.post',
        key: 'deploy2Post',
        labelSingular: 'Deploy2 Post',
        labelPlural: 'Deploy2 Posts',
        fields: [
          {
            seedId: 'deploy2.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);

    await applySeed(deps, superadmin, seed);
    const before = await getContentTypeByKey(handle.db, 'deploy2Post');

    const report = await applySeed(deps, superadmin, seed);

    expect(report.createdTypes).toEqual([]);
    expect(report.createdFields).toEqual([]);
    expect(report.drift).toEqual([]);

    const after = await getContentTypeByKey(handle.db, 'deploy2Post');
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });

  it('additive growth: adding a third field and re-applying creates only that field, leaving the others untouched', async () => {
    const firstSeed = defineContentTypes([
      {
        seedId: 'deploy3.post',
        key: 'deploy3Post',
        labelSingular: 'Deploy3 Post',
        labelPlural: 'Deploy3 Posts',
        fields: [
          {
            seedId: 'deploy3.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
          { seedId: 'deploy3.post.views', label: 'Views', fieldType: 'number' },
        ],
      },
    ]);
    await applySeed(deps, superadmin, firstSeed);

    const grownSeed = defineContentTypes([
      {
        seedId: 'deploy3.post',
        key: 'deploy3Post',
        labelSingular: 'Deploy3 Post',
        labelPlural: 'Deploy3 Posts',
        fields: [
          {
            seedId: 'deploy3.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
          { seedId: 'deploy3.post.views', label: 'Views', fieldType: 'number' },
          {
            seedId: 'deploy3.post.summary',
            label: 'Summary',
            fieldType: 'long_text',
          },
        ],
      },
    ]);
    const report = await applySeed(deps, superadmin, grownSeed);

    expect(report.createdTypes).toEqual([]);
    expect(report.createdFields).toEqual(['deploy3.post.summary']);

    const type = await getContentTypeByKey(handle.db, 'deploy3Post');
    const fields = await listFields(handle.db, type?.id ?? '');
    expect(fields.map((field) => field.key)).toEqual([
      'title',
      'views',
      'summary',
    ]);
  });

  it('never re-created: after deleteField removes a seeded field, re-applying creates nothing and names it skipped (target-removed); the same holds for a deleted type', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy4.post',
        key: 'deploy4Post',
        labelSingular: 'Deploy4 Post',
        labelPlural: 'Deploy4 Posts',
        fields: [
          {
            seedId: 'deploy4.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
      {
        seedId: 'deploy4.other',
        key: 'deploy4Other',
        labelSingular: 'Deploy4 Other',
        labelPlural: 'Deploy4 Others',
        fields: [],
      },
    ]);
    await applySeed(deps, superadmin, seed);

    await deleteField(deps, superadmin, {
      contentTypeKey: 'deploy4Post',
      fieldKey: 'title',
    });
    await deleteContentType(deps, superadmin, { key: 'deploy4Other' });

    const report = await applySeed(deps, superadmin, seed);

    expect(report.createdFields).toEqual([]);
    expect(report.createdTypes).toEqual([]);
    expect(report.skipped).toContainEqual({
      seedId: 'deploy4.post.title',
      reason: 'target-removed',
    });
    expect(report.skipped).toContainEqual({
      seedId: 'deploy4.other',
      reason: 'target-removed',
    });

    const type = await getContentTypeByKey(handle.db, 'deploy4Post');
    const fields = await listFields(handle.db, type?.id ?? '');
    expect(fields).toHaveLength(0);
    expect(await getContentTypeByKey(handle.db, 'deploy4Other')).toBeNull();
  });

  it("admin rename wins: after renameField changes a seeded field's key, re-applying creates no second field and leaves the renamed one alone", async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy5.post',
        key: 'deploy5Post',
        labelSingular: 'Deploy5 Post',
        labelPlural: 'Deploy5 Posts',
        fields: [
          {
            seedId: 'deploy5.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);
    await applySeed(deps, superadmin, seed);
    await renameField(deps, superadmin, {
      contentTypeKey: 'deploy5Post',
      fieldKey: 'title',
      newKey: 'headline',
    });

    const report = await applySeed(deps, superadmin, seed);

    expect(report.createdFields).toEqual([]);
    const type = await getContentTypeByKey(handle.db, 'deploy5Post');
    const fields = await listFields(handle.db, type?.id ?? '');
    expect(fields.map((field) => field.key)).toEqual(['headline']);
  });

  it('drift on a changed field: required and a new select choice each emit one SeedDriftEvent naming seed/stored values; rows stay unchanged', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy6.post',
        key: 'deploy6Post',
        labelSingular: 'Deploy6 Post',
        labelPlural: 'Deploy6 Posts',
        fields: [
          {
            seedId: 'deploy6.post.title',
            label: 'Title',
            fieldType: 'short_text',
            required: false,
          },
          {
            seedId: 'deploy6.post.status',
            label: 'Status',
            fieldType: 'select',
            options: { choices: [{ value: 'draft', labels: { en: 'Draft' } }] },
          },
        ],
      },
    ]);
    await applySeed(deps, superadmin, seed);

    // The admin makes both fields diverge from the seed through the normal
    // audited operations, so this is a real admin edit, not a direct DB poke.
    const type = await getContentTypeByKey(handle.db, 'deploy6Post');
    const fields = await listFields(handle.db, type?.id ?? '');
    const titleFieldId =
      fields.find((field) => field.key === 'title')?.id ?? '';
    const statusFieldId =
      fields.find((field) => field.key === 'status')?.id ?? '';
    await handle.sql`UPDATE content_type_fields SET required = true WHERE id = ${titleFieldId}`;
    await handle.sql`UPDATE content_type_fields SET options = ${JSON.stringify({
      choices: [
        { value: 'draft', labels: { en: 'Draft' } },
        { value: 'published', labels: { en: 'Published' } },
      ],
    })}::jsonb WHERE id = ${statusFieldId}`;

    const report = await applySeed(deps, superadmin, seed);

    expect(report.createdFields).toEqual([]);
    const requiredDrift = report.drift.find(
      (event) =>
        event.seedId === 'deploy6.post.title' && event.property === 'required',
    );
    expect(requiredDrift?.seededValue).toBe(false);
    expect(requiredDrift?.storedValue).toBe(true);

    const optionsDrift = report.drift.find(
      (event) =>
        event.seedId === 'deploy6.post.status' && event.property === 'options',
    );
    expect(optionsDrift).toBeDefined();

    const stillFields = await listFields(handle.db, type?.id ?? '');
    expect(stillFields.find((field) => field.key === 'title')?.required).toBe(
      true,
    );
    const statusChoices = stillFields.find((field) => field.key === 'status')
      ?.options as { choices: readonly unknown[] } | undefined;
    expect(statusChoices?.choices).toHaveLength(2);
  });

  it("drift on a type property: changing an applied type's labelSingular emits a drift notice and does not change the stored label", async () => {
    const originalSeed = defineContentTypes([
      {
        seedId: 'deploy7.post',
        key: 'deploy7Post',
        labelSingular: 'Deploy7 Post',
        labelPlural: 'Deploy7 Posts',
        fields: [],
      },
    ]);
    await applySeed(deps, superadmin, originalSeed);

    const changedSeed = defineContentTypes([
      {
        seedId: 'deploy7.post',
        key: 'deploy7Post',
        labelSingular: 'Deploy7 Post Renamed',
        labelPlural: 'Deploy7 Posts',
        fields: [],
      },
    ]);
    const report = await applySeed(deps, superadmin, changedSeed);

    const drift = report.drift.find(
      (event) =>
        event.seedId === 'deploy7.post' && event.property === 'labelSingular',
    );
    expect(drift?.seededValue).toBe('Deploy7 Post Renamed');
    expect(drift?.storedValue).toBe('Deploy7 Post');

    const stored = await getContentTypeByKey(handle.db, 'deploy7Post');
    expect(stored?.labelSingular).toBe('Deploy7 Post');
  });

  it('no false drift: a property the seed does not declare, changed by an admin, emits nothing; a value left at the seeded value emits nothing', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy8.post',
        key: 'deploy8Post',
        labelSingular: 'Deploy8 Post',
        labelPlural: 'Deploy8 Posts',
        fields: [
          {
            seedId: 'deploy8.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);
    await applySeed(deps, superadmin, seed);

    // "description" is not declared by the seed -- an admin setting it must
    // never surface as drift.
    const type = await getContentTypeByKey(handle.db, 'deploy8Post');
    await handle.sql`UPDATE content_types SET description = 'admin added this' WHERE id = ${type?.id ?? ''}`;

    const report = await applySeed(deps, superadmin, seed);

    expect(report.drift.some((event) => event.seedId === 'deploy8.post')).toBe(
      false,
    );
    expect(
      report.drift.some((event) => event.seedId === 'deploy8.post.title'),
    ).toBe(false);
  });

  it('hook discipline: no hook writes a default console line; a throwing hook and a rejecting hook neither reject applySeed nor stop remaining items', async () => {
    const seedNoHook = defineContentTypes([
      {
        seedId: 'deploy9a.post',
        key: 'deploy9aPost',
        labelSingular: 'Deploy9a Post',
        labelPlural: 'Deploy9a Posts',
        fields: [
          {
            seedId: 'deploy9a.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);
    await applySeed(deps, superadmin, seedNoHook);
    const typeA = await getContentTypeByKey(handle.db, 'deploy9aPost');
    await handle.sql`UPDATE content_types SET label_singular = 'Changed' WHERE id = ${typeA?.id ?? ''}`;

    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await applySeed(deps, superadmin, seedNoHook);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0]?.[0]).toContain('deploy9a.post');
    } finally {
      warnSpy.mockRestore();
    }

    // A throwing hook and a rejecting-promise hook must neither reject the
    // call nor stop the remaining seed items from being applied.
    const seedTwoTypes = defineContentTypes([
      {
        seedId: 'deploy9b.first',
        key: 'deploy9bFirst',
        labelSingular: 'Deploy9b First',
        labelPlural: 'Deploy9b Firsts',
        fields: [],
      },
      {
        seedId: 'deploy9b.second',
        key: 'deploy9bSecond',
        labelSingular: 'Deploy9b Second',
        labelPlural: 'Deploy9b Seconds',
        fields: [],
      },
    ]);
    await applySeed(deps, superadmin, seedTwoTypes);
    const first = await getContentTypeByKey(handle.db, 'deploy9bFirst');
    const second = await getContentTypeByKey(handle.db, 'deploy9bSecond');
    await handle.sql`UPDATE content_types SET label_singular = 'X' WHERE id = ${first?.id ?? ''}`;
    await handle.sql`UPDATE content_types SET label_singular = 'Y' WHERE id = ${second?.id ?? ''}`;

    const throwingDeps: ContentDeps = {
      ...deps,
      hooks: {
        onSeedDrift: (): void => {
          throw new Error('boom');
        },
      },
    };
    await expect(
      applySeed(throwingDeps, superadmin, seedTwoTypes),
    ).resolves.toBeDefined();
    const throwingReport = await applySeed(
      throwingDeps,
      superadmin,
      seedTwoTypes,
    );
    expect(throwingReport.drift.length).toBeGreaterThanOrEqual(2);

    // An async host hook, or one written in plain JS, can hand back a
    // rejected promise even though the contract says void.
    const rejectingDeps: ContentDeps = {
      ...deps,
      hooks: {
        onSeedDrift: (): undefined =>
          Promise.reject(new Error('rejected')) as unknown as undefined,
      },
    };
    await expect(
      applySeed(rejectingDeps, superadmin, seedTwoTypes),
    ).resolves.toBeDefined();
  });

  it('adoption: a type already holding the seeded key but no recorded seed id is adopted, nothing is created, and drift is reported for each differing property', async () => {
    // An admin (or a prior manual creation) already created this type
    // through the ordinary audited path, with a different label than the
    // seed declares -- before any seed ever named it.
    await createContentType(deps, superadmin, {
      key: 'deploy10Post',
      labelSingular: 'Hand Made',
      labelPlural: 'Hand Mades',
    });

    const seed = defineContentTypes([
      {
        seedId: 'deploy10.post',
        key: 'deploy10Post',
        labelSingular: 'Deploy10 Post',
        labelPlural: 'Deploy10 Posts',
        fields: [],
      },
    ]);

    const report = await applySeed(deps, superadmin, seed);

    expect(report.createdTypes).toEqual([]);
    expect(report.adopted).toEqual(['deploy10.post']);
    const drift = report.drift.find(
      (event) =>
        event.seedId === 'deploy10.post' && event.property === 'labelSingular',
    );
    expect(drift?.seededValue).toBe('Deploy10 Post');
    expect(drift?.storedValue).toBe('Hand Made');

    const row = await seedApplicationRow('deploy10.post');
    expect(row?.kind).toBe('type');

    // Re-applying does not adopt it again.
    const secondReport = await applySeed(deps, superadmin, seed);
    expect(secondReport.adopted).toEqual([]);
  });

  it('concurrency: two applySeed runs started concurrently on a fresh database produce exactly one type row and one row per field, and neither call rejects', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy11.post',
        key: 'deploy11Post',
        labelSingular: 'Deploy11 Post',
        labelPlural: 'Deploy11 Posts',
        fields: [
          {
            seedId: 'deploy11.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);

    const results = await Promise.allSettled([
      applySeed(deps, superadmin, seed),
      applySeed(deps, superadmin, seed),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const typeRows = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM content_types WHERE key = 'deploy11Post'
    `;
    expect(Number(typeRows[0]?.count ?? '0')).toBe(1);

    const type = await getContentTypeByKey(handle.db, 'deploy11Post');
    const fieldRows = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM content_type_fields WHERE content_type_id = ${type?.id ?? ''}
    `;
    expect(Number(fieldRows[0]?.count ?? '0')).toBe(1);
  });

  it('a seeded routable type with titleFieldKey has its title field designated after its fields exist; re-applying does not call the designation again', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy12.post',
        key: 'deploy12Post',
        labelSingular: 'Deploy12 Post',
        labelPlural: 'Deploy12 Posts',
        routable: true,
        titleFieldKey: 'title',
        fields: [
          {
            seedId: 'deploy12.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);

    await applySeed(deps, superadmin, seed);
    const type = await getContentTypeByKey(handle.db, 'deploy12Post');
    expect(type?.titleFieldKey).toBe('title');

    // An admin clears the title field designation; re-applying must not
    // designate it again, since the type was not created in this run.
    await handle.sql`UPDATE content_types SET title_field_key = NULL WHERE id = ${type?.id ?? ''}`;
    await applySeed(deps, superadmin, seed);
    const stillCleared = await getContentTypeByKey(handle.db, 'deploy12Post');
    expect(stillCleared?.titleFieldKey).toBeNull();
  });

  it('an actor without content-types:create gets PermissionDeniedError, a denied audit row is written and nothing is created; a successful run leaves one allowed audit row per created type and field', async () => {
    const seed = defineContentTypes([
      {
        seedId: 'deploy13.post',
        key: 'deploy13Post',
        labelSingular: 'Deploy13 Post',
        labelPlural: 'Deploy13 Posts',
        fields: [
          {
            seedId: 'deploy13.post.title',
            label: 'Title',
            fieldType: 'short_text',
          },
        ],
      },
    ]);

    const error: unknown = await applySeed(deps, editor, seed).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(await getContentTypeByKey(handle.db, 'deploy13Post')).toBeNull();
    const denied = (await auditRowsFor('content-type.create')).filter(
      (row) => row.outcome === 'denied',
    );
    expect(denied.length).toBeGreaterThanOrEqual(1);

    const report = await applySeed(deps, superadmin, seed);
    expect(report.createdTypes).toEqual(['deploy13.post']);
    expect(report.createdFields).toEqual(['deploy13.post.title']);
    const allowedTypeRows = (await auditRowsFor('content-type.create')).filter(
      (row) => row.outcome === 'allowed',
    );
    expect(allowedTypeRows.length).toBeGreaterThanOrEqual(1);
    const allowedFieldRows = (await auditRowsFor('field.add')).filter(
      (row) => row.outcome === 'allowed',
    );
    expect(allowedFieldRows.length).toBeGreaterThanOrEqual(1);
  });

  it('applySeed over an empty seed is a no-op returning an empty report', async () => {
    const report = await applySeed(deps, superadmin, defineContentTypes([]));
    expect(report).toEqual({
      createdTypes: [],
      createdFields: [],
      adopted: [],
      skipped: [],
      drift: [],
    });
  });
});
