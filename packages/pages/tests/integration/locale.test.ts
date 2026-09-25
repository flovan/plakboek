import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import {
  createContentType,
  createEntry,
  defineContentConfig,
  type ContentDeps,
} from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  definePagesConfig,
  type LocaleRemovedEvent,
  type PagesConfig,
  type PagesDeps,
} from '../../src/config.js';
import {
  checkPageLocales,
  computeLocalePurgeImpact,
  LocaleStillEnabledError,
  purgeLocale,
  reportPageLocaleRemoval,
} from '../../src/locale.js';
import { createPage, getPage, renamePage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { insertBlock, readBlockTree } from '../../src/tree.js';
import {
  createPageTranslation,
  listPageTranslations,
  PageTranslationExistsError,
} from '../../src/translations.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  // A purpose-built role for the asymmetric-permission test: holds
  // pages:delete-permanent but never entries:delete-permanent -- no
  // shipped default role carries exactly one of the pair.
  'pages-purge-only': [
    'pages:read',
    'pages:create',
    'pages:edit',
    'pages:delete-permanent',
  ],
});

const ALL_TEST_LOCALES = ['en', 'nl', 'de', 'fr', 'it', 'pt'];

describe('Page locales, translation groups and the cross-package purge (D-34, D-36, D-37)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let superadmin: AuditActor;
  let pagesPurgeOnlyActor: AuditActor;
  let depsFull: PagesDeps;
  let depsWithoutDe: PagesDeps;
  let depsWithoutFr: PagesDeps;
  let depsWithoutPt: PagesDeps;
  const clock = (): Date => new Date('2026-09-25T12:00:00.000Z');

  function makePagesConfig(locales: readonly string[]): PagesConfig {
    return definePagesConfig({
      content: defineContentConfig({
        locales: [...locales],
        defaultLocale: 'en',
        timezone: 'UTC',
      }),
      blocks: defineBlocks([
        {
          key: 'hero',
          editor: { label: 'Hero' },
          schemaVersion: 1,
          properties: {},
        },
      ]),
    });
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });

    depsFull = {
      db: handle.db,
      recorder,
      resolver,
      config: makePagesConfig(ALL_TEST_LOCALES),
      now: clock,
    };
    depsWithoutDe = {
      ...depsFull,
      config: makePagesConfig(ALL_TEST_LOCALES.filter((l) => l !== 'de')),
    };
    depsWithoutFr = {
      ...depsFull,
      config: makePagesConfig(ALL_TEST_LOCALES.filter((l) => l !== 'fr')),
    };
    depsWithoutPt = {
      ...depsFull,
      config: makePagesConfig(ALL_TEST_LOCALES.filter((l) => l !== 'pt')),
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

    superadmin = await makeUser(
      'locale-owner@example.com',
      SUPERADMIN_ROLE_KEY,
    );
    pagesPurgeOnlyActor = await makeUser(
      'locale-pages-purge@example.com',
      'pages-purge-only',
    );
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  let typeCounter = 0;
  function uniqueContentTypeKey(prefix: string): string {
    typeCounter += 1;
    return `${prefix}${typeCounter}`;
  }

  function contentDepsFor(deps: PagesDeps): ContentDeps {
    return { db: handle.db, recorder, resolver, config: deps.config.content };
  }

  it('createPageTranslation adds an enabled locale to an existing group with its own slug/path and an empty tree; either locale may start the group; block trees stay independent; a duplicate call is refused; listPageTranslations returns one row per locale in order (D-21, D-34, D-36)', async () => {
    const rootEn = await createPage(depsFull, superadmin, {
      locale: 'en',
      title: 'Translate Me',
    });
    const rootNl = await createPageTranslation(depsFull, superadmin, {
      pageId: rootEn.id,
      locale: 'nl',
    });
    expect(rootNl.translationGroup).toBe(rootEn.translationGroup);
    expect(rootNl.locale).toBe('nl');
    expect(rootNl.parentPageId).toBeNull();
    expect(rootNl.status).toBe('draft');
    expect(rootNl.version).toBe(1);
    expect(rootNl.slug).toBe('translate-me');

    // The reverse direction: an `nl` root can start a group too.
    const reverseRootNl = await createPage(depsFull, superadmin, {
      locale: 'nl',
      title: 'Begonnen In Nl',
    });
    const reverseRootEn = await createPageTranslation(depsFull, superadmin, {
      pageId: reverseRootNl.id,
      locale: 'en',
    });
    expect(reverseRootEn.translationGroup).toBe(reverseRootNl.translationGroup);
    expect(reverseRootEn.locale).toBe('en');

    const duplicateError: unknown = await createPageTranslation(
      depsFull,
      superadmin,
      { pageId: rootEn.id, locale: 'nl' },
    ).catch((caught: unknown) => caught);
    expect(duplicateError).toBeInstanceOf(PageTranslationExistsError);
    expect(
      (duplicateError as PageTranslationExistsError).translationGroup,
    ).toBe(rootEn.translationGroup);
    expect((duplicateError as PageTranslationExistsError).locale).toBe('nl');

    const enBlock = await insertBlock(depsFull, superadmin, {
      owner: { ownerType: 'page', ownerId: rootEn.id, locale: 'en' },
      blockType: 'hero',
      parentBlockId: null,
      basePageVersion: rootEn.version,
    });
    const enTree = await readBlockTree(depsFull.db, {
      ownerType: 'page',
      ownerId: rootEn.id,
      locale: 'en',
    });
    const nlTree = await readBlockTree(depsFull.db, {
      ownerType: 'page',
      ownerId: rootNl.id,
      locale: 'nl',
    });
    expect(enTree.map((node) => node.id)).toEqual([enBlock.id]);
    expect(nlTree).toHaveLength(0);

    const translations = await listPageTranslations(
      depsFull.db,
      depsFull.config,
      { translationGroup: rootEn.translationGroup },
    );
    expect(translations.map((page) => page.locale)).toEqual(['en', 'nl']);
    expect(translations.map((page) => page.id).sort()).toEqual(
      [rootEn.id, rootNl.id].sort(),
    );
  });

  it("checkPageLocales reports a removed locale's page/block/revision/publication/URL-history counts, boot succeeds, rows stay in the database, and re-adding the locale restores full access with no data operation (D-37)", async () => {
    const deRoot = await createPage(depsFull, superadmin, {
      locale: 'de',
      title: 'Removed Locale Root',
    });
    await createPageTranslation(depsFull, superadmin, {
      pageId: deRoot.id,
      locale: 'en',
    });

    await insertBlock(depsFull, superadmin, {
      owner: { ownerType: 'page', ownerId: deRoot.id, locale: 'de' },
      blockType: 'hero',
      parentBlockId: null,
      basePageVersion: deRoot.version,
    });
    const afterInsert = await getPage(depsFull.db, deRoot.id);
    await publishPage(depsFull, superadmin, {
      pageId: deRoot.id,
      baseVersion: afterInsert!.version,
    });
    const afterPublish = await getPage(depsFull.db, deRoot.id);

    const report = await checkPageLocales(
      depsWithoutDe.db,
      depsWithoutDe.config,
    );
    const deEntry = report.find((entry) => entry.locale === 'de');
    expect(deEntry).toEqual({
      locale: 'de',
      pageCount: 1,
      blockCount: 1,
      blockRevisionCount: 2, // one 'create' (insertBlock), one 'publish' (publishPage)
      publicationCount: 1,
      urlHistoryCount: 0,
    });

    const events: LocaleRemovedEvent[] = [];
    reportPageLocaleRemoval(
      {
        ...depsWithoutDe,
        hooks: { onLocaleRemoved: (event) => events.push(event) },
      },
      report,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.locale).toBe('de');
    expect(events[0]?.pageCount).toBe(1);

    // The row stays in the database, completely untouched.
    const [rawCount] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM pages WHERE id = ${deRoot.id}
    `;
    expect(rawCount?.count).toBe('1');

    // Excluded from listPageTranslations while the locale is removed.
    const translationsWithoutDe = await listPageTranslations(
      depsWithoutDe.db,
      depsWithoutDe.config,
      { translationGroup: deRoot.translationGroup },
    );
    expect(translationsWithoutDe.map((page) => page.locale)).toEqual(['en']);

    // Re-adding the locale makes it readable again -- no data operation, the
    // very same row and version reappear.
    const translationsWithDe = await listPageTranslations(
      depsFull.db,
      depsFull.config,
      { translationGroup: deRoot.translationGroup },
    );
    expect(translationsWithDe.map((page) => page.locale)).toEqual(['de', 'en']);
    const restoredDeRoot = translationsWithDe.find(
      (page) => page.locale === 'de',
    );
    expect(restoredDeRoot?.id).toBe(deRoot.id);
    expect(restoredDeRoot?.version).toBe(afterPublish!.version);
  });

  it('computeLocalePurgeImpact reports counts across both engines and writes nothing; purgeLocale then deletes pages, blocks, revisions, publications, URL history and entries for that locale in one transaction, leaving the "en" sibling of the same group intact (D-37)', async () => {
    const contentDeps = contentDepsFor(depsFull);
    const entryType = await createContentType(contentDeps, superadmin, {
      key: uniqueContentTypeKey('localePurgeArticle'),
      labelSingular: 'Locale purge article',
      labelPlural: 'Locale purge articles',
    });
    await createEntry(contentDeps, superadmin, {
      contentTypeKey: entryType.key,
      locale: 'fr',
      data: {},
    });

    // A translation group with a surviving `en` sibling -- purging `fr`
    // must leave it untouched.
    const groupEnRoot = await createPage(depsFull, superadmin, {
      locale: 'en',
      title: 'Purge Group Root',
    });
    const groupFrTranslation = await createPageTranslation(
      depsFull,
      superadmin,
      { pageId: groupEnRoot.id, locale: 'fr' },
    );

    // A slug change generates one `page_url_history` row for `fr`.
    const renamed = await renamePage(depsFull, superadmin, {
      pageId: groupFrTranslation.id,
      baseVersion: groupFrTranslation.version,
      slug: 'renommee',
    });

    await insertBlock(depsFull, superadmin, {
      owner: { ownerType: 'page', ownerId: renamed.id, locale: 'fr' },
      blockType: 'hero',
      parentBlockId: null,
      basePageVersion: renamed.version,
    });
    const afterBlockInsert = await getPage(depsFull.db, renamed.id);
    await publishPage(depsFull, superadmin, {
      pageId: renamed.id,
      baseVersion: afterBlockInsert!.version,
    });

    const impact = await computeLocalePurgeImpact(depsWithoutFr, {
      locale: 'fr',
    });
    expect(impact.locale).toBe('fr');
    expect(impact.pages).toEqual({
      locale: 'fr',
      pageCount: 1,
      blockCount: 1,
      blockRevisionCount: 2,
      publicationCount: 1,
      urlHistoryCount: 1,
    });
    expect(impact.entries.entryCount).toBe(1);

    const [beforePageCount] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM pages
    `;

    const result = await purgeLocale(depsWithoutFr, superadmin, {
      locale: 'fr',
    });
    expect(result).toEqual(impact);

    const [afterPageCount] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM pages
    `;
    expect(Number(afterPageCount?.count)).toBe(
      Number(beforePageCount?.count) - 1,
    );

    const [frPagesRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM pages WHERE locale = 'fr'
    `;
    expect(frPagesRemaining?.count).toBe('0');
    const [frBlocksRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM page_blocks WHERE locale = 'fr'
    `;
    expect(frBlocksRemaining?.count).toBe('0');
    const [frRevisionsRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM block_revisions WHERE locale = 'fr'
    `;
    expect(frRevisionsRemaining?.count).toBe('0');
    const [frPublicationsRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM page_publications WHERE locale = 'fr'
    `;
    expect(frPublicationsRemaining?.count).toBe('0');
    const [frUrlHistoryRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM page_url_history WHERE locale = 'fr'
    `;
    expect(frUrlHistoryRemaining?.count).toBe('0');
    const [frEntriesRemaining] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE locale = 'fr'
    `;
    expect(frEntriesRemaining?.count).toBe('0');

    // The `en` sibling of the same translation group survives untouched.
    const survivingEn = await getPage(depsFull.db, groupEnRoot.id);
    expect(survivingEn?.version).toBe(groupEnRoot.version);
  });

  it('purgeLocale refuses when the locale is still enabled, before any read or write (D-37)', async () => {
    const stillEnabledError: unknown = await purgeLocale(depsFull, superadmin, {
      locale: 'it',
    }).catch((caught: unknown) => caught);
    expect(stillEnabledError).toBeInstanceOf(LocaleStillEnabledError);
    expect((stillEnabledError as LocaleStillEnabledError).locale).toBe('it');
  });

  it('an actor holding pages:delete-permanent but not entries:delete-permanent gets PermissionDeniedError and a denied audit row naming entries:delete-permanent, and nothing is deleted from either engine (D-37)', async () => {
    const contentDeps = contentDepsFor(depsFull);
    const entryType = await createContentType(contentDeps, superadmin, {
      key: uniqueContentTypeKey('localePurgePtArticle'),
      labelSingular: 'pt article',
      labelPlural: 'pt articles',
    });
    const ptEntry = await createEntry(contentDeps, superadmin, {
      contentTypeKey: entryType.key,
      locale: 'pt',
      data: {},
    });
    const ptPage = await createPage(depsFull, superadmin, {
      locale: 'pt',
      title: 'Portuguese Root',
    });

    const deniedError: unknown = await purgeLocale(
      depsWithoutPt,
      pagesPurgeOnlyActor,
      { locale: 'pt' },
    ).catch((caught: unknown) => caught);
    expect(deniedError).toBeInstanceOf(PermissionDeniedError);

    const deniedRows = await handle.sql<
      { outcome: string; permission: string }[]
    >`
      SELECT outcome, permission FROM audit_log
      WHERE action = 'locale.purge' AND entity_id = 'pt' AND outcome = 'denied'
    `;
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0]?.permission).toBe('entries:delete-permanent');

    const [pageStillThere] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM pages WHERE id = ${ptPage.id}
    `;
    expect(pageStillThere?.count).toBe('1');
    const [entryStillThere] = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_entries WHERE id = ${ptEntry.id}
    `;
    expect(entryStillThere?.count).toBe('1');
  });
});
