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
import {
  createEntry,
  EntryNotFoundError,
  LocaleNotEnabledError,
} from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import { publishEntry } from '../../src/publish.js';
import {
  createTranslation,
  TranslationExistsError,
} from '../../src/translations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('Translation groups: createTranslation across enabled locales (D-21, I18N-04)', () => {
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

  async function setUrlPattern(
    contentTypeId: string,
    pattern: string | null,
  ): Promise<void> {
    await handle.sql`UPDATE content_types SET url_pattern = ${pattern} WHERE id = ${contentTypeId}`;
  }

  async function setSlugDirect(
    entryId: string,
    slug: string | null,
  ): Promise<void> {
    await handle.sql`UPDATE content_entries SET slug = ${slug} WHERE id = ${entryId}`;
  }

  it('createEntry in nl on a type whose default locale is en succeeds and starts a group (D-21)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'startsInNl',
      labelSingular: 'Starts in nl',
      labelPlural: 'Starts in nl',
    });

    const nlEntry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: {},
    });
    expect(nlEntry.locale).toBe('nl');
    expect(nlEntry.translationGroup).toEqual(expect.any(String));
    expect(nlEntry.publicId).toEqual(expect.any(Number));
  });

  it('createTranslation copies non-translatable values, refuses an existing locale, and refuses a disabled one; both rows publish independently', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'translationArticle',
      labelSingular: 'Translation article',
      labelPlural: 'Translation articles',
      routable: true,
    });
    await setUrlPattern(type.id, '/a/{slug}');
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'sku',
      label: 'SKU',
      fieldType: 'short_text',
      translatable: false,
    });

    const nlEntry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { title: 'NL titel', sku: 'SKU-1' },
    });

    const enEntry = await createTranslation(deps, editor, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: { title: 'Hello' },
    });

    expect(enEntry.translationGroup).toBe(nlEntry.translationGroup);
    expect(enEntry.publicId).toBe(nlEntry.publicId);
    expect(enEntry.locale).toBe('en');
    expect(enEntry.status).toBe('draft');
    expect(enEntry.slug).toBeNull();
    expect(enEntry.data).toEqual({ title: 'Hello', sku: 'SKU-1' });

    const nlAgain: unknown = await createTranslation(deps, editor, {
      sourceEntryId: nlEntry.id,
      locale: 'nl',
    }).catch((caught: unknown) => caught);
    expect(nlAgain).toBeInstanceOf(TranslationExistsError);

    const enAgain: unknown = await createTranslation(deps, editor, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
    }).catch((caught: unknown) => caught);
    expect(enAgain).toBeInstanceOf(TranslationExistsError);

    const disabledLocale: unknown = await createTranslation(deps, editor, {
      sourceEntryId: nlEntry.id,
      locale: 'fr',
    }).catch((caught: unknown) => caught);
    expect(disabledLocale).toBeInstanceOf(LocaleNotEnabledError);

    await setSlugDirect(nlEntry.id, 'hello');
    await setSlugDirect(enEntry.id, 'hello');

    const nlPublished = await publishEntry(deps, editor, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
    });
    const enPublished = await publishEntry(deps, editor, {
      entryId: enEntry.id,
      baseVersion: enEntry.version,
    });

    expect(nlPublished.status).toBe('published');
    expect(nlPublished.resolvedPath).toBe('/a/hello');
    expect(enPublished.status).toBe('published');
    expect(enPublished.resolvedPath).toBe('/a/hello');
  });

  it('createTranslation on a missing source entry throws EntryNotFoundError', async () => {
    const error: unknown = await createTranslation(deps, editor, {
      sourceEntryId: randomUUID(),
      locale: 'nl',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EntryNotFoundError);
  });

  it('createTranslation with only translatable input data leaves an unset non-translatable field empty', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'translationNoSku',
      labelSingular: 'Translation no sku',
      labelPlural: 'Translation no skus',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });

    const nlEntry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { title: 'NL titel' },
    });
    const enEntry = await createTranslation(deps, editor, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: { title: 'Hello' },
    });
    expect(enEntry.data).toEqual({ title: 'Hello' });
  });
});
