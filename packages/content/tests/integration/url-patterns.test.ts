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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import { createEntry } from '../../src/entries.js';
import { publishEntry } from '../../src/publish.js';
import {
  computeUrlPatternChangeImpact,
  setUrlPattern,
  UrlPatternCollisionError,
  UrlPatternInUseError,
  UrlPatternRequiredError,
} from '../../src/routing.js';
import { UrlPatternError } from '../../src/url-pattern.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles });

describe('URL pattern changes: collision refusal and history (D-31, D-32, D-33)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;

  let superadmin: AuditActor;
  let editor: AuditActor;

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

    deps = {
      db: handle.db,
      recorder,
      resolver,
      config,
      now: () => new Date(),
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

    superadmin = await makeUser('url-pattern-owner@example.com', 'superadmin');
    editor = await makeUser('url-pattern-editor@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function setSlugDirect(
    entryId: string,
    slug: string | null,
  ): Promise<void> {
    await handle.sql`UPDATE content_entries SET slug = ${slug} WHERE id = ${entryId}`;
  }

  async function createRoutableType(key: string, pattern: string | null) {
    const type = await createContentType(deps, superadmin, {
      key,
      labelSingular: key,
      labelPlural: key,
      routable: true,
    });
    if (pattern !== null) {
      await setUrlPattern(deps, superadmin, {
        contentTypeKey: key,
        urlPattern: pattern,
      });
    }
    return type;
  }

  async function createAndPublishEntry(
    typeKey: string,
    locale: string,
    slug: string,
  ) {
    const entry = await createEntry(deps, editor, {
      contentTypeKey: typeKey,
      locale,
      data: {},
    });
    await setSlugDirect(entry.id, slug);
    return await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
  }

  async function getResolvedPath(entryId: string): Promise<string | null> {
    const [row] = await handle.sql<{ resolved_path: string | null }[]>`
      SELECT resolved_path FROM content_entries WHERE id = ${entryId}
    `;
    return row?.resolved_path ?? null;
  }

  async function getStoredUrlPattern(
    contentTypeId: string,
  ): Promise<string | null> {
    const [row] = await handle.sql<{ url_pattern: string | null }[]>`
      SELECT url_pattern FROM content_types WHERE id = ${contentTypeId}
    `;
    return row?.url_pattern ?? null;
  }

  it('changing the pattern updates both published paths and writes two pattern_changed history rows; computeUrlPatternChangeImpact beforehand reports changedPaths: 2 and no collisions', async () => {
    const type = await createRoutableType('newsType', '/news/{slug}');
    const first = await createAndPublishEntry(type.key, 'en', 'first-story');
    const second = await createAndPublishEntry(type.key, 'en', 'second-story');
    expect(first.resolvedPath).toBe('/news/first-story');
    expect(second.resolvedPath).toBe('/news/second-story');

    const impact = await computeUrlPatternChangeImpact(deps.db, deps.config, {
      contentTypeKey: type.key,
      urlPattern: '/articles/{slug}',
    });
    expect(impact.publishedEntries).toBe(2);
    expect(impact.changedPaths).toBe(2);
    expect(impact.collisions).toHaveLength(0);

    const result = await setUrlPattern(deps, superadmin, {
      contentTypeKey: type.key,
      urlPattern: '/articles/{slug}',
    });
    expect(result.changedPaths).toBe(2);
    expect(result.urlPattern).toBe('/articles/{slug}');

    expect(await getResolvedPath(first.id)).toBe('/articles/first-story');
    expect(await getResolvedPath(second.id)).toBe('/articles/second-story');

    const historyRows = await handle.sql<{ old_path: string }[]>`
      SELECT old_path FROM content_entry_url_history
      WHERE reason = 'pattern_changed' AND entry_id IN (${first.id}, ${second.id})
    `;
    expect(historyRows).toHaveLength(2);
    expect(historyRows.map((row) => row.old_path).sort()).toEqual(
      ['/news/first-story', '/news/second-story'].sort(),
    );
  });

  it('changing to a no-token pattern throws UrlPatternCollisionError listing locale en with both entry ids; stored pattern and both paths are unchanged', async () => {
    const type = await createRoutableType(
      'collisionNoTokenType',
      '/collision-notoken/{slug}',
    );
    const alpha = await createAndPublishEntry(type.key, 'en', 'alpha');
    const beta = await createAndPublishEntry(type.key, 'en', 'beta');

    const error: unknown = await setUrlPattern(deps, superadmin, {
      contentTypeKey: type.key,
      urlPattern: '/collision-notoken',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UrlPatternCollisionError);
    const collisionError = error as UrlPatternCollisionError;
    expect(collisionError.collisions).toHaveLength(1);
    const [collision] = collisionError.collisions;
    expect(collision?.locale).toBe('en');
    expect(collision?.path).toBe('/collision-notoken');
    expect([...(collision?.entryIds ?? [])].sort()).toEqual(
      [alpha.id, beta.id].sort(),
    );

    expect(await getStoredUrlPattern(type.id)).toBe(
      '/collision-notoken/{slug}',
    );
    expect(await getResolvedPath(alpha.id)).toBe('/collision-notoken/alpha');
    expect(await getResolvedPath(beta.id)).toBe('/collision-notoken/beta');
  });

  it('a pattern change whose new path equals a published path of an entry of another type is refused and lists both entries', async () => {
    const typeA = await createRoutableType('crossTypeA', '/cross-a/{slug}');
    const entryA = await createAndPublishEntry(typeA.key, 'en', 'shared');
    expect(entryA.resolvedPath).toBe('/cross-a/shared');

    const typeB = await createRoutableType('crossTypeB', '/cross-b/{slug}');
    const entryB = await createAndPublishEntry(typeB.key, 'en', 'shared');
    expect(entryB.resolvedPath).toBe('/cross-b/shared');

    const error: unknown = await setUrlPattern(deps, superadmin, {
      contentTypeKey: typeB.key,
      urlPattern: '/cross-a/{slug}',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UrlPatternCollisionError);
    const collisionError = error as UrlPatternCollisionError;
    expect(collisionError.collisions).toHaveLength(1);
    const [collision] = collisionError.collisions;
    expect(collision?.locale).toBe('en');
    expect(collision?.path).toBe('/cross-a/shared');
    expect([...(collision?.entryIds ?? [])].sort()).toEqual(
      [entryA.id, entryB.id].sort(),
    );

    expect(await getStoredUrlPattern(typeB.id)).toBe('/cross-b/{slug}');
    expect(await getResolvedPath(entryB.id)).toBe('/cross-b/shared');
  });

  it('the same new path for entries in different locales is accepted', async () => {
    const type = await createRoutableType('localeOkType', '/locale-ok/{slug}');
    const enEntry = await createAndPublishEntry(
      type.key,
      'en',
      'shared-slug-locale',
    );
    const nlEntry = await createAndPublishEntry(
      type.key,
      'nl',
      'shared-slug-locale',
    );
    expect(enEntry.resolvedPath).toBe('/locale-ok/shared-slug-locale');
    expect(nlEntry.resolvedPath).toBe('/locale-ok/shared-slug-locale');

    const impact = await computeUrlPatternChangeImpact(deps.db, deps.config, {
      contentTypeKey: type.key,
      urlPattern: '/locale-ok-2/{slug}',
    });
    expect(impact.collisions).toHaveLength(0);

    const result = await setUrlPattern(deps, superadmin, {
      contentTypeKey: type.key,
      urlPattern: '/locale-ok-2/{slug}',
    });
    expect(result.changedPaths).toBe(2);

    expect(await getResolvedPath(enEntry.id)).toBe(
      '/locale-ok-2/shared-slug-locale',
    );
    expect(await getResolvedPath(nlEntry.id)).toBe(
      '/locale-ok-2/shared-slug-locale',
    );
  });

  it('two published entries whose paths swap under the new pattern are updated without a unique violation', async () => {
    const type = await createRoutableType('swapType', '/swap/{slug}');
    const alpha = await createAndPublishEntry(type.key, 'en', 'alpha-swap');
    const beta = await createAndPublishEntry(type.key, 'en', 'beta-swap');
    expect(alpha.resolvedPath).toBe('/swap/alpha-swap');
    expect(beta.resolvedPath).toBe('/swap/beta-swap');

    // Swap the two entries' slugs directly (an admin editing each entry),
    // leaving their stale resolved_path values in place until the next
    // recompute -- exactly the scenario a pattern-set recompute must survive
    // without tripping the unique index mid-update. The three-step dance
    // (clear, then set each in turn) is needed only to get the fixture into
    // this state without tripping content_entries_type_locale_slug_unique
    // itself -- a different constraint than the one setUrlPattern is tested
    // against, but the same "never write the same value twice at once"
    // shape.
    await setSlugDirect(alpha.id, null);
    await setSlugDirect(beta.id, 'alpha-swap');
    await setSlugDirect(alpha.id, 'beta-swap');

    const result = await setUrlPattern(deps, superadmin, {
      contentTypeKey: type.key,
      urlPattern: '/swap/{slug}',
    });
    expect(result.changedPaths).toBe(2);

    expect(await getResolvedPath(alpha.id)).toBe('/swap/beta-swap');
    expect(await getResolvedPath(beta.id)).toBe('/swap/alpha-swap');
  });

  it('setting an invalid pattern throws UrlPatternError; a non-routable type throws UrlPatternRequiredError; clearing the pattern while entries are published throws UrlPatternInUseError with the count; a first pattern on a routable type with no published entries succeeds', async () => {
    const invalidType = await createRoutableType('invalidPatternType', null);
    const invalidError: unknown = await setUrlPattern(deps, superadmin, {
      contentTypeKey: invalidType.key,
      urlPattern: 'missing-leading-slash',
    }).catch((caught: unknown) => caught);
    expect(invalidError).toBeInstanceOf(UrlPatternError);

    const nonRoutableType = await createContentType(deps, superadmin, {
      key: 'nonRoutablePatternType',
      labelSingular: 'Non-routable pattern type',
      labelPlural: 'Non-routable pattern types',
      routable: false,
    });
    const nonRoutableError: unknown = await setUrlPattern(deps, superadmin, {
      contentTypeKey: nonRoutableType.key,
      urlPattern: '/whatever/{slug}',
    }).catch((caught: unknown) => caught);
    expect(nonRoutableError).toBeInstanceOf(UrlPatternRequiredError);

    const inUseType = await createRoutableType(
      'inUsePatternType',
      '/in-use/{slug}',
    );
    await createAndPublishEntry(inUseType.key, 'en', 'still-published');
    const inUseError: unknown = await setUrlPattern(deps, superadmin, {
      contentTypeKey: inUseType.key,
      urlPattern: null,
    }).catch((caught: unknown) => caught);
    expect(inUseError).toBeInstanceOf(UrlPatternInUseError);
    expect(inUseError).toMatchObject({ publishedCount: 1 });

    const firstPatternResult = await setUrlPattern(deps, superadmin, {
      contentTypeKey: invalidType.key,
      urlPattern: '/first-pattern/{slug}',
    });
    expect(firstPatternResult.changedPaths).toBe(0);
    expect(firstPatternResult.urlPattern).toBe('/first-pattern/{slug}');
  });

  it('a user without content-types:edit gets PermissionDeniedError and a denied row', async () => {
    const type = await createRoutableType(
      'permissionPatternType',
      '/permission/{slug}',
    );

    const error: unknown = await setUrlPattern(deps, editor, {
      contentTypeKey: type.key,
      urlPattern: '/permission-2/{slug}',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const denied = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'content-type.set-url-pattern' AND outcome = 'denied'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(denied).toHaveLength(1);
  });
});
