import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  PAGE_SEARCH_LIMIT,
  resolvePageLinkPaths,
  searchPages,
} from '../../src/page-links.js';
import { trashPage } from '../../src/lifecycle.js';
import { createPage, getPage } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import { DEFAULT_HOME_SLUG } from '../../src/visitor.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('page links: search for the picker and id-to-path resolution (D-18)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  const statements: string[] = [];
  let countingDb: AuditDatabase;

  const ids: Record<string, string> = {};
  const lookup = {
    defaultLocale: 'en',
    homeSlug: DEFAULT_HOME_SLUG,
  } as const;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;
    countingDb = drizzle({
      client: handle.sql,
      logger: {
        logQuery(query: string): void {
          statements.push(query);
        },
      },
    });

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({ db, resolver });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en', 'nl'],
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
    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    deps = { db, recorder, resolver, config };

    const create = async (
      key: string,
      locale: string,
      title: string,
      slug?: string,
    ): Promise<void> => {
      const page = await createPage(deps, actor, {
        locale,
        title,
        ...(slug === undefined ? {} : { slug }),
      });
      ids[key] = page.id;
    };
    await create('aboutUs', 'en', 'About us', 'about-us');
    await create('aboutTeam', 'en', 'About the team', 'team');
    await create('contact', 'en', 'Contact', 'contact');
    await create('percent', 'en', '100% pure', 'pure');
    await create('underscore', 'en', 'a_b', 'under');
    await create('plain', 'en', 'axb', 'plain');
    await create('dutch', 'nl', 'About Dutch', 'over');
    await create('gone', 'en', 'About gone', 'gone');

    const trashTarget = await getPage(db, ids.gone!);
    await trashPage(deps, actor, {
      pageId: ids.gone!,
      baseVersion: trashTarget?.version ?? 0,
    });

    const aboutUs = await getPage(db, ids.aboutUs!);
    await publishPage(deps, actor, {
      pageId: ids.aboutUs!,
      baseVersion: aboutUs?.version ?? 0,
    });
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  it('finds pages of one locale by title, never another locale or a trashed page', async () => {
    const results = await searchPages(db, {
      locale: 'en',
      query: 'about',
      ...lookup,
    });
    expect(results.map((result) => result.title)).toEqual([
      'About the team',
      'About us',
    ]);
  });

  it('matches a query against the path as well and returns the public path', async () => {
    const results = await searchPages(db, {
      locale: 'en',
      query: 'about-us',
      ...lookup,
    });
    expect(results).toEqual([
      {
        id: ids.aboutUs,
        title: 'About us',
        path: 'about-us',
        publicPath: '/about-us',
        live: true,
      },
    ]);
  });

  it('flags only a published page as live', async () => {
    const results = await searchPages(db, {
      locale: 'en',
      query: 'about',
      ...lookup,
    });
    const live = Object.fromEntries(
      results.map((result) => [result.id, result.live]),
    );
    expect(live).toEqual({ [ids.aboutUs!]: true, [ids.aboutTeam!]: false });
  });

  it('matches wildcard characters in the query literally', async () => {
    const percent = await searchPages(db, {
      locale: 'en',
      query: '100%',
      ...lookup,
    });
    expect(percent.map((result) => result.id)).toEqual([ids.percent]);

    const underscore = await searchPages(db, {
      locale: 'en',
      query: 'a_b',
      ...lookup,
    });
    expect(underscore.map((result) => result.id)).toEqual([ids.underscore]);

    const backslash = await searchPages(db, {
      locale: 'en',
      query: '\\',
      ...lookup,
    });
    expect(backslash).toEqual([]);
  });

  it('lists the first pages by title for an empty query, capped at the limit', async () => {
    for (let index = 0; index < 22; index += 1) {
      await createPage(deps, actor, {
        locale: 'nl',
        title: `Bulk ${String(index).padStart(2, '0')}`,
      });
    }
    const nl = await searchPages(db, { locale: 'nl', query: '', ...lookup });
    expect(nl).toHaveLength(PAGE_SEARCH_LIMIT);
    const titles = nl.map((result) => result.title);
    expect(titles).toEqual(titles.toSorted((a, b) => a.localeCompare(b)));

    const en = await searchPages(db, { locale: 'en', query: '  ', ...lookup });
    expect(en.map((result) => result.title)).not.toContain('About gone');
    expect(en.map((result) => result.title)).not.toContain('About Dutch');
    expect(en).toHaveLength(6);
  });

  it('resolves ids to the same public paths search reports, and ignores unknown ids', async () => {
    const found = await resolvePageLinkPaths(db, {
      pageIds: [ids.aboutUs!, ids.contact!, ids.gone!, randomUUID()],
      liveOnly: false,
      ...lookup,
    });
    expect(Object.fromEntries(found)).toEqual({
      [ids.aboutUs!]: '/about-us',
      [ids.contact!]: '/contact',
    });
  });

  it('resolves a page of a non-default locale with its prefix', async () => {
    const found = await resolvePageLinkPaths(db, {
      pageIds: [ids.dutch!],
      liveOnly: false,
      ...lookup,
    });
    expect(found.get(ids.dutch!)).toBe('/nl/over');
  });

  it('leaves out pages that are not live when asked for live pages only', async () => {
    const found = await resolvePageLinkPaths(db, {
      pageIds: [ids.aboutUs!, ids.contact!],
      liveOnly: true,
      ...lookup,
    });
    expect([...found.keys()]).toEqual([ids.aboutUs]);
  });

  it('issues no statement for no ids and at most two for many', async () => {
    statements.length = 0;
    const none = await resolvePageLinkPaths(countingDb, {
      pageIds: [],
      liveOnly: true,
      ...lookup,
    });
    expect(none.size).toBe(0);
    expect(statements).toHaveLength(0);

    await resolvePageLinkPaths(countingDb, {
      pageIds: [ids.aboutUs!, ids.contact!, ids.aboutTeam!, ids.aboutUs!],
      liveOnly: false,
      ...lookup,
    });
    expect(statements.length).toBeLessThanOrEqual(2);
    expect(statements.length).toBeGreaterThan(0);
  });
});
