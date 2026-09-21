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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defineContentConfig,
  type ContentDeps,
  type LocaleRemovedEvent,
} from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import {
  createEntry,
  findEntry,
  findTranslations,
  getEntry,
  listEntries,
  LocaleNotEnabledError,
} from '../../src/entries.js';
import { trashEntry } from '../../src/lifecycle.js';
import { checkContentLocales } from '../../src/locales.js';
import { publishEntry } from '../../src/publish.js';
import { saveEntry } from '../../src/save.js';
import { createTranslation } from '../../src/translations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('Locale safety net: boot check, filtered reads, removed-locale write refusal (D-24, D-25)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let depsWithDe: ContentDeps;
  let depsWithoutDe: ContentDeps;
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

    depsWithDe = {
      db: handle.db,
      recorder,
      resolver,
      config: defineContentConfig({
        locales: ['en', 'nl', 'de'],
        defaultLocale: 'en',
        timezone: 'Europe/Brussels',
      }),
    };
    depsWithoutDe = {
      db: handle.db,
      recorder,
      resolver,
      config: defineContentConfig({
        locales: ['en', 'nl'],
        defaultLocale: 'en',
        timezone: 'Europe/Brussels',
      }),
    };

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

  it('checkContentLocales reports a removed locale once via onLocaleRemoved, warns by default, and never throws for a broken hook (D-24)', async () => {
    const type = await createContentType(depsWithDe, superadmin, {
      key: 'localeCheckArticle',
      labelSingular: 'Locale check article',
      labelPlural: 'Locale check articles',
    });
    const en = await createEntry(depsWithDe, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await createTranslation(depsWithDe, editor, {
      sourceEntryId: en.id,
      locale: 'de',
    });

    const events: LocaleRemovedEvent[] = [];
    const withHook = await checkContentLocales({
      ...depsWithoutDe,
      hooks: {
        onLocaleRemoved: (event) => {
          events.push(event);
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.locale).toBe('de');
    expect(events[0]?.entryCount).toBe(1);
    expect(withHook.removedLocales).toEqual([{ locale: 'de', entryCount: 1 }]);

    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await checkContentLocales(depsWithoutDe);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }

    const throwingHookReport = await checkContentLocales({
      ...depsWithoutDe,
      hooks: {
        onLocaleRemoved: () => {
          throw new Error('hook boom');
        },
      },
    });
    expect(throwingHookReport.removedLocales).toEqual([
      { locale: 'de', entryCount: 1 },
    ]);

    // An async host hook, or one written in plain JS, can hand back a
    // rejected promise even though the contract says void.
    const rejectingHookReport = await checkContentLocales({
      ...depsWithoutDe,
      hooks: {
        onLocaleRemoved: (): undefined =>
          Promise.reject(new Error('hook boom')) as unknown as undefined,
      },
    });
    expect(rejectingHookReport.removedLocales).toEqual([
      { locale: 'de', entryCount: 1 },
    ]);
  });

  it('findEntry excludes a removed-locale row while getEntry still returns it, and findTranslations omits it from its group (D-25)', async () => {
    const type = await createContentType(depsWithDe, superadmin, {
      key: 'localeCheckReads',
      labelSingular: 'Locale check reads',
      labelPlural: 'Locale check reads',
    });
    const en = await createEntry(depsWithDe, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const de = await createTranslation(depsWithDe, editor, {
      sourceEntryId: en.id,
      locale: 'de',
    });

    const foundWithDe = await findEntry(handle.db, depsWithDe.config, {
      entryId: de.id,
    });
    expect(foundWithDe?.id).toBe(de.id);

    const foundWithoutDe = await findEntry(handle.db, depsWithoutDe.config, {
      entryId: de.id,
    });
    expect(foundWithoutDe).toBeNull();

    const unfiltered = await getEntry(handle.db, de.id);
    expect(unfiltered?.id).toBe(de.id);

    const translationsWithoutDe = await findTranslations(
      handle.db,
      depsWithoutDe.config,
      { translationGroup: en.translationGroup },
    );
    expect(translationsWithoutDe.map((entry) => entry.locale)).toEqual(['en']);

    const translationsWithDe = await findTranslations(
      handle.db,
      depsWithDe.config,
      { translationGroup: en.translationGroup },
    );
    expect(translationsWithDe.map((entry) => entry.locale)).toEqual([
      'en',
      'de',
    ]);
  });

  it('listEntries requires a locale, refuses a removed one, excludes trashed unless included, and orders same-instant entries by id (TYPE-10 ordering)', async () => {
    const type = await createContentType(depsWithDe, superadmin, {
      key: 'localeCheckList',
      labelSingular: 'Locale check list',
      labelPlural: 'Locale check list',
    });

    const localeError: unknown = await listEntries(
      handle.db,
      depsWithoutDe.config,
      { contentTypeKey: type.key, locale: 'de' },
    ).catch((caught: unknown) => caught);
    expect(localeError).toBeInstanceOf(LocaleNotEnabledError);

    const fixedNow = new Date('2026-01-01T00:00:00.000Z');
    const frozenDeps: ContentDeps = { ...depsWithDe, now: () => fixedNow };

    const first = await createEntry(frozenDeps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const second = await createEntry(frozenDeps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const third = await createEntry(frozenDeps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const trashed = await trashEntry(depsWithDe, editor, {
      entryId: second.id,
      baseVersion: second.version,
    });

    const active = await listEntries(handle.db, depsWithDe.config, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    expect(active.map((entry) => entry.id)).toEqual(
      [first.id, third.id].sort(),
    );

    const withTrashed = await listEntries(handle.db, depsWithDe.config, {
      contentTypeKey: type.key,
      locale: 'en',
      includeTrashed: true,
    });
    expect(withTrashed.map((entry) => entry.id)).toEqual(
      [first.id, trashed.id, third.id].sort(),
    );
  });

  it('saveEntry, publishEntry and trashEntry refuse a removed-locale row, leaving it, its version and its revisions unchanged (D-25)', async () => {
    const type = await createContentType(depsWithDe, superadmin, {
      key: 'localeCheckWrites',
      labelSingular: 'Locale check writes',
      labelPlural: 'Locale check writes',
      revisions: true,
      revisionMode: 'on_every_save',
    });
    const en = await createEntry(depsWithDe, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const de = await createTranslation(depsWithDe, editor, {
      sourceEntryId: en.id,
      locale: 'de',
    });

    const [before] = await handle.sql<
      { version: number; updatedAt: Date }[]
    >`SELECT version, updated_at AS "updatedAt" FROM content_entries WHERE id = ${de.id}`;
    const [revisionCountBefore] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) FROM entry_revisions WHERE entry_id = ${de.id}`;

    const saveError: unknown = await saveEntry(depsWithoutDe, editor, {
      entryId: de.id,
      baseVersion: de.version,
      data: {},
    }).catch((caught: unknown) => caught);
    expect(saveError).toBeInstanceOf(LocaleNotEnabledError);

    const publishError: unknown = await publishEntry(depsWithoutDe, editor, {
      entryId: de.id,
      baseVersion: de.version,
    }).catch((caught: unknown) => caught);
    expect(publishError).toBeInstanceOf(LocaleNotEnabledError);

    const trashError: unknown = await trashEntry(depsWithoutDe, editor, {
      entryId: de.id,
      baseVersion: de.version,
    }).catch((caught: unknown) => caught);
    expect(trashError).toBeInstanceOf(LocaleNotEnabledError);

    const [after] = await handle.sql<
      { version: number; updatedAt: Date }[]
    >`SELECT version, updated_at AS "updatedAt" FROM content_entries WHERE id = ${de.id}`;
    const [revisionCountAfter] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) FROM entry_revisions WHERE entry_id = ${de.id}`;

    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(revisionCountAfter?.count).toBe(revisionCountBefore?.count);
  });

  it('re-adding the locale to config makes a previously removed-locale row readable and editable again', async () => {
    const type = await createContentType(depsWithDe, superadmin, {
      key: 'localeCheckReenable',
      labelSingular: 'Locale check reenable',
      labelPlural: 'Locale check reenable',
    });
    const en = await createEntry(depsWithDe, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const de = await createTranslation(depsWithDe, editor, {
      sourceEntryId: en.id,
      locale: 'de',
    });

    const excludedWhileRemoved = await findEntry(
      handle.db,
      depsWithoutDe.config,
      { entryId: de.id },
    );
    expect(excludedWhileRemoved).toBeNull();

    const restored = await findEntry(handle.db, depsWithDe.config, {
      entryId: de.id,
    });
    expect(restored?.id).toBe(de.id);

    const saved = await saveEntry(depsWithDe, editor, {
      entryId: de.id,
      baseVersion: de.version,
      data: {},
    });
    expect(saved.id).toBe(de.id);
    expect(saved.version).toBe(de.version + 1);
  });

  it('the boot check and every read leave stored rows completely untouched (row count, updated_at)', async () => {
    const type = await createContentType(depsWithDe, superadmin, {
      key: 'localeCheckUntouched',
      labelSingular: 'Locale check untouched',
      labelPlural: 'Locale check untouched',
    });
    const en = await createEntry(depsWithDe, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const de = await createTranslation(depsWithDe, editor, {
      sourceEntryId: en.id,
      locale: 'de',
    });

    const [beforeCount] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) FROM content_entries`;
    const [beforeRow] = await handle.sql<
      { updatedAt: Date }[]
    >`SELECT updated_at AS "updatedAt" FROM content_entries WHERE id = ${de.id}`;

    await checkContentLocales(depsWithoutDe);
    await findEntry(handle.db, depsWithoutDe.config, { entryId: de.id });
    await getEntry(handle.db, de.id);
    await findTranslations(handle.db, depsWithoutDe.config, {
      translationGroup: en.translationGroup,
    });

    const [afterCount] = await handle.sql<
      { count: string }[]
    >`SELECT count(*) FROM content_entries`;
    const [afterRow] = await handle.sql<
      { updatedAt: Date }[]
    >`SELECT updated_at AS "updatedAt" FROM content_entries WHERE id = ${de.id}`;

    expect(afterCount?.count).toBe(beforeCount?.count);
    expect(afterRow?.updatedAt).toEqual(beforeRow?.updatedAt);
  });
});
