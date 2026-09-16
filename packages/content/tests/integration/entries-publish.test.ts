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
import { createContentType, setTitleField } from '../../src/content-types.js';
import { createEntry, getEntry } from '../../src/entries.js';
import { addField, updateField } from '../../src/fields.js';
import {
  UrlCollisionError,
  UrlPatternRequiredError,
} from '../../src/routing.js';
import {
  publishEntry,
  SlugRequiredError,
  type PublishEntryInput,
} from '../../src/publish.js';
import { StaleVersionError } from '../../src/save.js';
import { EntrySeoValidationError } from '../../src/seo.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  contributor: ['entries:read', 'entries:create', 'entries:edit'],
});

/** A controllable clock: `deps.now` reads `current`, and `advance` moves it
 * forward by a number of seconds. Only ever moves forward, matching real
 * usage -- other tests in this file don't depend on a specific value, only
 * on ordering (before < after). */
function makeClock(startIso: string) {
  let current = new Date(startIso);
  return {
    now: (): Date => current,
    advance(seconds: number): void {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

describe('Publishing an entry: slug rules, URL materialisation, URL history and draft promotion (TYPE-04, TYPE-06, TYPE-07, TYPE-09, TYPE-10)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let clock: ReturnType<typeof makeClock>;

  let superadmin: AuditActor;
  let editor: AuditActor;
  let contributor: AuditActor;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });
    clock = makeClock('2026-01-05T09:00:00.000Z');

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
      now: clock.now,
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
    contributor = await makeUser('contributor@example.com', 'contributor');
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

  /** Stages a pending draft revision (kind `save`) pointing `entryId`'s
   * `draft_revision_id` at it and bumping `version` -- simulates a save
   * plan 03-07's Task 2 would otherwise make, without depending on it. */
  async function stagePendingRevision(
    entryId: string,
    data: Record<string, unknown>,
    options: { readonly seo?: unknown; readonly slug?: string | null } = {},
  ): Promise<number> {
    const revisionId = randomUUID();
    const now = clock.now().toISOString();
    await handle.sql`
      INSERT INTO entry_revisions
        (id, entry_id, locale, kind, data, field_ids, seo, slug, author_id, created_at)
      VALUES
        (${revisionId}, ${entryId}, 'en', 'save', ${JSON.stringify(data)}::jsonb, '{}'::jsonb,
         ${options.seo === undefined ? null : JSON.stringify(options.seo)}::jsonb,
         ${options.slug ?? null}, NULL, ${now})
    `;
    const [row] = await handle.sql<{ version: number }[]>`
      UPDATE content_entries
      SET draft_revision_id = ${revisionId}, version = version + 1
      WHERE id = ${entryId}
      RETURNING version
    `;
    if (row === undefined) {
      throw new Error(`fixture: no entry found for id "${entryId}"`);
    }
    return row.version;
  }

  async function publish(input: PublishEntryInput) {
    return await publishEntry(deps, editor, input);
  }

  it('a routable entry with no slug throws SlugRequiredError; the same with a whitespace-only slug fixture', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'noSlugArticle',
      labelSingular: 'No slug article',
      labelPlural: 'No slug articles',
      routable: true,
    });
    await setUrlPattern(type.id, '/news/{slug}');

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const noSlugError: unknown = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    }).catch((caught: unknown) => caught);
    expect(noSlugError).toBeInstanceOf(SlugRequiredError);

    const whitespaceEntry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(whitespaceEntry.id, '  ');

    const whitespaceError: unknown = await publish({
      entryId: whitespaceEntry.id,
      baseVersion: whitespaceEntry.version,
    }).catch((caught: unknown) => caught);
    expect(whitespaceError).toBeInstanceOf(SlugRequiredError);
  });

  it('a routable type with no URL pattern throws UrlPatternRequiredError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'noPatternArticle',
      labelSingular: 'No pattern article',
      labelPlural: 'No pattern articles',
      routable: true,
    });

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entry.id, 'has-a-slug');

    const error: unknown = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UrlPatternRequiredError);
    expect(error).toMatchObject({ contentTypeId: type.id });
  });

  it('title-driven slug generation, status, resolved path and firstPublishedAt === publishedAt on first publish', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'article',
      labelSingular: 'Article',
      labelPlural: 'Articles',
      routable: true,
    });
    await setUrlPattern(type.id, '/news/{slug}');
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });
    await setTitleField(deps, superadmin, { key: type.key, fieldKey: 'title' });

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { title: 'Hello World' },
    });

    const published = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    });

    expect(published.slug).toBe('hello-world');
    expect(published.status).toBe('published');
    expect(published.resolvedPath).toBe('/news/hello-world');
    expect(published.firstPublishedAt).not.toBeNull();
    expect(published.publishedAt).not.toBeNull();
    expect(published.firstPublishedAt?.getTime()).toBe(
      published.publishedAt?.getTime(),
    );
  });

  it('date tokens resolve from the frozen first-publish instant across a timezone-crossing New Year, and never move on republish', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'yearArticle',
      labelSingular: 'Year article',
      labelPlural: 'Year articles',
      routable: true,
    });
    await setUrlPattern(type.id, '/news/{year}/{slug}');

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entry.id, 'hello-world');

    const startingTime = new Date('2026-12-31T23:30:00.000Z');
    const drift = startingTime.getTime() - clock.now().getTime();
    clock.advance(Math.round(drift / 1000));

    const firstPublish = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(firstPublish.resolvedPath).toBe('/news/2027/hello-world');
    const firstPublishedAt = firstPublish.firstPublishedAt;
    expect(firstPublishedAt).not.toBeNull();

    clock.advance(365 * 24 * 60 * 60); // a year later
    const republished = await publish({
      entryId: entry.id,
      baseVersion: firstPublish.version,
    });
    expect(republished.resolvedPath).toBe('/news/2027/hello-world');
    expect(republished.firstPublishedAt?.getTime()).toBe(
      firstPublishedAt?.getTime(),
    );
    expect(republished.publishedAt?.getTime()).not.toBe(
      firstPublish.publishedAt?.getTime(),
    );
  });

  it('a second entry of a different routable type resolving to the same path in the same locale is refused; the same path in a different locale publishes', async () => {
    const firstType = await createContentType(deps, superadmin, {
      key: 'primaryNews',
      labelSingular: 'Primary news',
      labelPlural: 'Primary news',
      routable: true,
    });
    await setUrlPattern(firstType.id, '/shared/{slug}');
    const firstEntry = await createEntry(deps, editor, {
      contentTypeKey: firstType.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(firstEntry.id, 'shared-slug');
    const firstPublished = await publish({
      entryId: firstEntry.id,
      baseVersion: firstEntry.version,
    });
    expect(firstPublished.resolvedPath).toBe('/shared/shared-slug');

    const secondType = await createContentType(deps, superadmin, {
      key: 'secondaryNews',
      labelSingular: 'Secondary news',
      labelPlural: 'Secondary news',
      routable: true,
    });
    await setUrlPattern(secondType.id, '/shared/{slug}');

    const collidingEntry = await createEntry(deps, editor, {
      contentTypeKey: secondType.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(collidingEntry.id, 'shared-slug');

    const collisionError: unknown = await publish({
      entryId: collidingEntry.id,
      baseVersion: collidingEntry.version,
    }).catch((caught: unknown) => caught);
    expect(collisionError).toBeInstanceOf(UrlCollisionError);
    expect(collisionError).toMatchObject({
      path: '/shared/shared-slug',
      locale: 'en',
      conflictingEntryId: firstEntry.id,
    });

    const nlEntry = await createEntry(deps, editor, {
      contentTypeKey: secondType.key,
      locale: 'nl',
      data: {},
    });
    await setSlugDirect(nlEntry.id, 'shared-slug');
    const nlPublished = await publish({
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
    });
    expect(nlPublished.resolvedPath).toBe('/shared/shared-slug');
    expect(nlPublished.locale).toBe('nl');
  });

  it('two entries resolving to one path published concurrently: exactly one succeeds, the other gets UrlCollisionError', async () => {
    // Two distinct content types, same pattern: content_entries_type_locale_slug_unique
    // scopes the slug column to (content type, locale), so two entries of
    // the SAME type could never even be given the same slug -- the race is
    // on resolved_path, which is unique across every type sharing a locale.
    const typeA = await createContentType(deps, superadmin, {
      key: 'raceArticleA',
      labelSingular: 'Race article A',
      labelPlural: 'Race articles A',
      routable: true,
    });
    await setUrlPattern(typeA.id, '/race/{slug}');
    const typeB = await createContentType(deps, superadmin, {
      key: 'raceArticleB',
      labelSingular: 'Race article B',
      labelPlural: 'Race articles B',
      routable: true,
    });
    await setUrlPattern(typeB.id, '/race/{slug}');

    const entryA = await createEntry(deps, editor, {
      contentTypeKey: typeA.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entryA.id, 'race-slug');
    const entryB = await createEntry(deps, editor, {
      contentTypeKey: typeB.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entryB.id, 'race-slug');

    const [resultA, resultB] = await Promise.allSettled([
      publish({ entryId: entryA.id, baseVersion: entryA.version }),
      publish({ entryId: entryB.id, baseVersion: entryB.version }),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(UrlCollisionError);
  });

  it('a non-routable type publishes with slug null and resolvedPath null', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'nonRoutableThing',
      labelSingular: 'Non-routable thing',
      labelPlural: 'Non-routable things',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const published = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(published.status).toBe('published');
    expect(published.slug).toBeNull();
    expect(published.resolvedPath).toBeNull();
  });

  it('publishing a pending draft that no longer satisfies the schema throws FieldValidationError and leaves the live data unchanged', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'strictArticle',
      labelSingular: 'Strict article',
      labelPlural: 'Strict articles',
      routable: true,
    });
    await setUrlPattern(type.id, '/strict/{slug}');
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'body',
      label: 'Body',
      fieldType: 'short_text',
    });

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entry.id, 'strict-one');

    const firstPublish = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(firstPublish.status).toBe('published');

    // Now "body" becomes required with no default -- existing entries (this
    // one included) are left as-is (D-18), so a pending save missing it is
    // no longer valid.
    await updateField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'body',
      required: true,
    });

    const newVersion = await stagePendingRevision(entry.id, {});

    const error: unknown = await publish({
      entryId: entry.id,
      baseVersion: newVersion,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FieldValidationError);

    const unchanged = await getEntry(deps.db, entry.id);
    expect(unchanged?.data).toEqual(firstPublish.data);
    expect(unchanged?.status).toBe('published');
    expect(unchanged?.resolvedPath).toBe(firstPublish.resolvedPath);
    expect(unchanged?.version).toBe(newVersion);
  });

  it('D-46: a staged SEO set is promoted complete on publish; an entry that never received SEO publishes with seo null', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'seoArticle',
      labelSingular: 'SEO article',
      labelPlural: 'SEO articles',
      routable: true,
      seo: true,
    });
    await setUrlPattern(type.id, '/seo/{slug}');

    const withSeo = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(withSeo.id, 'with-seo');
    const stagedVersion = await stagePendingRevision(
      withSeo.id,
      {},
      { seo: { title: 'Hello' }, slug: 'with-seo' },
    );

    const publishedWithSeo = await publish({
      entryId: withSeo.id,
      baseVersion: stagedVersion,
    });
    expect(publishedWithSeo.seo).toEqual({
      title: 'Hello',
      description: null,
      imageAssetId: null,
      canonicalUrl: null,
      noindex: false,
      nofollow: false,
      sitemapInclude: true,
    });

    const withoutSeo = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(withoutSeo.id, 'without-seo');
    const publishedWithoutSeo = await publish({
      entryId: withoutSeo.id,
      baseVersion: withoutSeo.version,
    });
    expect(publishedWithoutSeo.seo).toBeNull();
  });

  it('D-46: staged SEO that breaks its own rules throws EntrySeoValidationError and leaves live data, status and path unchanged', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'seoStrictArticle',
      labelSingular: 'SEO strict article',
      labelPlural: 'SEO strict articles',
      routable: true,
      seo: true,
    });
    await setUrlPattern(type.id, '/seo-strict/{slug}');

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entry.id, 'seo-strict-one');
    const firstPublish = await publish({
      entryId: entry.id,
      baseVersion: entry.version,
    });

    const stagedVersion = await stagePendingRevision(
      entry.id,
      {},
      { seo: { canonicalUrl: '/not-absolute' } },
    );

    const error: unknown = await publish({
      entryId: entry.id,
      baseVersion: stagedVersion,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EntrySeoValidationError);

    const unchanged = await getEntry(deps.db, entry.id);
    expect(unchanged?.data).toEqual(firstPublish.data);
    expect(unchanged?.status).toBe('published');
    expect(unchanged?.resolvedPath).toBe(firstPublish.resolvedPath);
  });

  it('a stale base version throws StaleVersionError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'staleArticle',
      labelSingular: 'Stale article',
      labelPlural: 'Stale articles',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const error: unknown = await publish({
      entryId: entry.id,
      baseVersion: entry.version + 999,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleVersionError);
  });

  it('an actor without entries:publish gets PermissionDeniedError and a denied audit row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'permissionArticle',
      labelSingular: 'Permission article',
      labelPlural: 'Permission articles',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const error: unknown = await publishEntry(deps, contributor, {
      entryId: entry.id,
      baseVersion: entry.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const denied = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'entry.publish' AND outcome = 'denied'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(denied).toHaveLength(1);
  });
});
