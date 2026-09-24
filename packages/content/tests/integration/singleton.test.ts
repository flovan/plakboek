import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import { createEntry, listEntries } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { saveEntry } from '../../src/save.js';
import {
  findSingleton,
  getOrCreateSingleton,
  listSingletonRecords,
  SingletonEntryError,
} from '../../src/singletons.js';
import { InvalidSlugError } from '../../src/slug.js';
import { createTranslation } from '../../src/translations.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('Singletons: one record per enabled locale, no slug, no list (TYPE-11, D-22)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let editor: AuditActor;
  let superadmin: AuditActor;

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

    deps = { db: handle.db, recorder, resolver, config };

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

  it('findSingleton returns null before a record exists, getOrCreateSingleton creates a slug-less record, and a second call is idempotent (TYPE-11 empty)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'siteSettings',
      labelSingular: 'Site settings',
      labelPlural: 'Site settings',
      singleton: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'logoAssetId',
      label: 'Logo asset id',
      fieldType: 'short_text',
      translatable: false,
    });

    const before = await findSingleton(handle.db, deps.config, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    expect(before).toBeNull();

    const created = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { logoAssetId: 'logo-en' },
    });
    expect(created.locale).toBe('en');
    expect(created.slug).toBeNull();
    expect(created.status).toBe('draft');
    expect(created.data.logoAssetId).toBe('logo-en');

    const again = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { logoAssetId: 'ignored-on-existing' },
    });
    expect(again.id).toBe(created.id);
    expect(again.data.logoAssetId).toBe('logo-en');

    const found = await findSingleton(handle.db, deps.config, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    expect(found?.id).toBe(created.id);
  });

  it('getOrCreateSingleton for a second locale shares the group and copies the shared logoAssetId (D-22)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'siteSettingsTwoLocales',
      labelSingular: 'Site settings 2',
      labelPlural: 'Site settings 2',
      singleton: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'logoAssetId',
      label: 'Logo asset id',
      fieldType: 'short_text',
      translatable: false,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'heading',
      label: 'Heading',
      fieldType: 'short_text',
    });

    const en = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { logoAssetId: 'logo-1', heading: 'Hello' },
    });
    const nl = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { heading: 'Hallo' },
    });

    expect(nl.translationGroup).toBe(en.translationGroup);
    expect(nl.publicId).toBe(en.publicId);
    expect(nl.data.logoAssetId).toBe('logo-1');
    expect(nl.data.heading).toBe('Hallo');
  });

  it('createEntry and createTranslation refuse a singleton type; listEntries refuses it too; listSingletonRecords orders by config locale order (TYPE-11 ordering)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'siteSettingsOrdering',
      labelSingular: 'Site settings order',
      labelPlural: 'Site settings order',
      singleton: true,
    });

    const createEntryError: unknown = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    }).catch((caught: unknown) => caught);
    expect(createEntryError).toBeInstanceOf(SingletonEntryError);
    expect((createEntryError as SingletonEntryError).reason).toBe(
      'singleton-type',
    );

    // nl created first, en second -- listSingletonRecords must still return
    // them in config order (en, nl), never insertion order.
    const nl = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: {},
    });
    const en = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const createTranslationError: unknown = await createTranslation(
      deps,
      editor,
      { sourceEntryId: nl.id, locale: 'en' },
    ).catch((caught: unknown) => caught);
    expect(createTranslationError).toBeInstanceOf(SingletonEntryError);

    const listEntriesError: unknown = await listEntries(
      handle.db,
      deps.config,
      { contentTypeKey: type.key, locale: 'en' },
    ).catch((caught: unknown) => caught);
    expect(listEntriesError).toBeInstanceOf(SingletonEntryError);

    const records = await listSingletonRecords(handle.db, deps.config, {
      contentTypeKey: type.key,
    });
    expect(records.map((record) => record.locale)).toEqual(['en', 'nl']);
    expect(records[0]?.id).toBe(en.id);
    expect(records[1]?.id).toBe(nl.id);
  });

  it('a slug on a singleton record is refused and stays null; saving a shared field syncs across its locales (D-22)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'siteSettingsSave',
      labelSingular: 'Site settings save',
      labelPlural: 'Site settings save',
      singleton: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'logoAssetId',
      label: 'Logo asset id',
      fieldType: 'short_text',
      translatable: false,
    });

    const en = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { logoAssetId: 'logo-a' },
    });
    const nl = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: {},
    });

    const slugError: unknown = await saveEntry(deps, editor, {
      entryId: en.id,
      baseVersion: en.version,
      data: { logoAssetId: 'logo-a' },
      slug: 'not-allowed',
    }).catch((caught: unknown) => caught);
    expect(slugError).toBeInstanceOf(InvalidSlugError);

    const unchanged = await findSingleton(handle.db, deps.config, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    expect(unchanged?.slug).toBeNull();

    const savedNl = await saveEntry(deps, editor, {
      entryId: nl.id,
      baseVersion: nl.version,
      data: { logoAssetId: 'logo-b' },
    });
    expect(savedNl.data.logoAssetId).toBe('logo-b');

    const syncedEn = await findSingleton(handle.db, deps.config, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    expect(syncedEn?.data.logoAssetId).toBe('logo-b');
  });

  it('two concurrent getOrCreateSingleton calls for the same locale produce one row and return the same id (TYPE-11 adjacency)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'siteSettingsConcurrent',
      labelSingular: 'Site settings concurrent',
      labelPlural: 'Site settings concurrent',
      singleton: true,
    });

    const [first, second] = await Promise.all([
      getOrCreateSingleton(deps, editor, {
        contentTypeKey: type.key,
        locale: 'en',
        data: {},
      }),
      getOrCreateSingleton(deps, editor, {
        contentTypeKey: type.key,
        locale: 'en',
        data: {},
      }),
    ]);
    expect(first.id).toBe(second.id);

    const records = await listSingletonRecords(handle.db, deps.config, {
      contentTypeKey: type.key,
    });
    expect(records).toHaveLength(1);
  });

  it('getOrCreateSingleton refuses a non-singleton type (TYPE-11 encoding) and enforces required fields', async () => {
    const nonSingleton = await createContentType(deps, superadmin, {
      key: 'plainArticleForSingletonTest',
      labelSingular: 'Plain article',
      labelPlural: 'Plain articles',
    });
    const notSingletonError: unknown = await getOrCreateSingleton(
      deps,
      editor,
      { contentTypeKey: nonSingleton.key, locale: 'en', data: {} },
    ).catch((caught: unknown) => caught);
    expect(notSingletonError).toBeInstanceOf(SingletonEntryError);
    expect((notSingletonError as SingletonEntryError).reason).toBe(
      'not-singleton',
    );

    const requiredType = await createContentType(deps, superadmin, {
      key: 'siteSettingsRequired',
      labelSingular: 'Site settings required',
      labelPlural: 'Site settings required',
      singleton: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: requiredType.key,
      key: 'heading',
      label: 'Heading',
      fieldType: 'short_text',
      required: true,
    });

    const validationError: unknown = await getOrCreateSingleton(deps, editor, {
      contentTypeKey: requiredType.key,
      locale: 'en',
      data: {},
    }).catch((caught: unknown) => caught);
    expect(validationError).toBeInstanceOf(FieldValidationError);
  });
});
