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
import { createEntry } from '../../src/entries.js';
import { addField } from '../../src/fields.js';
import {
  publishEntry,
  readWorkingCopy,
  EntryStateChangedError,
} from '../../src/publish.js';
import { UrlCollisionError } from '../../src/routing.js';
import {
  saveEntry,
  StaleVersionError,
  type SaveEntryInput,
} from '../../src/save.js';
import { InvalidSlugError, SlugConflictError } from '../../src/slug.js';
import { EntrySeoValidationError } from '../../src/seo.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  contributor: ['entries:read', 'entries:create', 'entries:edit'],
});

describe('Draft-versus-live saves and title-driven slugs (TYPE-05, TYPE-07, TYPE-09, D-11, D-27, D-28, D-46, D-47)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;

  let superadmin: AuditActor;
  let editor: AuditActor;
  let contributor: AuditActor;

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

  async function slugSourceOf(entryId: string): Promise<string | null> {
    const [row] = await handle.sql<{ slugSource: string | null }[]>`
      SELECT slug_source AS "slugSource" FROM content_entries WHERE id = ${entryId}
    `;
    return row?.slugSource ?? null;
  }

  async function saveRevisionCount(entryId: string): Promise<number> {
    const [row] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entry_revisions
      WHERE entry_id = ${entryId} AND kind = 'save'
    `;
    return row?.count ?? 0;
  }

  async function urlHistoryRows(
    entryId: string,
  ): Promise<{ oldPath: string; reason: string }[]> {
    return await handle.sql<{ oldPath: string; reason: string }[]>`
      SELECT old_path AS "oldPath", reason
      FROM content_entry_url_history
      WHERE entry_id = ${entryId}
      ORDER BY id
    `;
  }

  async function insertSiblingLocaleRow(
    contentTypeId: string,
    translationGroup: string,
    publicId: number,
    locale: string,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await handle.sql`
      INSERT INTO content_entries
        (id, content_type_id, translation_group, public_id, locale, status, data, version, created_at, updated_at)
      VALUES
        (${id}, ${contentTypeId}, ${translationGroup}, ${publicId}, ${locale}, 'draft', '{}'::jsonb, 1, ${now}, ${now})
    `;
    return id;
  }

  async function save(input: SaveEntryInput) {
    return await saveEntry(deps, editor, input);
  }

  it('drafts on, never published: a save updates data directly and draftRevisionId stays null', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'draftBranchType',
      labelSingular: 'Draft branch type',
      labelPlural: 'Draft branch types',
      drafts: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'note',
      label: 'Note',
      fieldType: 'short_text',
    });

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const saved = await save({
      entryId: entry.id,
      baseVersion: entry.version,
      data: { note: 'hello' },
    });
    expect(saved.data).toEqual({ note: 'hello' });
    expect(saved.draftRevisionId).toBeNull();
    expect(saved.status).toBe('draft');
  });

  it('drafts on, published: a save leaves live data/status unchanged, stages a draft, and a second save replaces the pending revision', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'draftBranchType2',
      labelSingular: 'Draft branch type 2',
      labelPlural: 'Draft branch types 2',
      drafts: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'note',
      label: 'Note',
      fieldType: 'short_text',
    });

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { note: 'original' },
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(published.status).toBe('published');

    const firstSave = await save({
      entryId: entry.id,
      baseVersion: published.version,
      data: { note: 'pending-1' },
    });
    expect(firstSave.status).toBe('published');
    expect(firstSave.data).toEqual({ note: 'original' });
    expect(firstSave.draftRevisionId).not.toBeNull();

    const secondSave = await save({
      entryId: entry.id,
      baseVersion: firstSave.version,
      data: { note: 'pending-2' },
    });
    expect(secondSave.status).toBe('published');
    expect(secondSave.data).toEqual({ note: 'original' });
    expect(secondSave.draftRevisionId).not.toBeNull();

    expect(await saveRevisionCount(entry.id)).toBe(1);

    const workingCopy = await readWorkingCopy(deps.db, entry.id);
    expect(workingCopy.data).toEqual({ note: 'pending-2' });
  });

  it('drafts off, published: an actor without entries:publish is denied; one with it updates live data and creates no revision row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'liveOffType',
      labelSingular: 'Live off type',
      labelPlural: 'Live off types',
      drafts: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });

    const denied: unknown = await saveEntry(deps, contributor, {
      entryId: entry.id,
      baseVersion: published.version,
      data: {},
    }).catch((caught: unknown) => caught);
    expect(denied).toBeInstanceOf(PermissionDeniedError);

    const savedLive = await save({
      entryId: entry.id,
      baseVersion: published.version,
      data: {},
    });
    expect(savedLive.status).toBe('published');
    expect(savedLive.draftRevisionId).toBeNull();
    expect(await saveRevisionCount(entry.id)).toBe(0);
  });

  it('drafts off, published, a hand-typed slug change updates resolvedPath and writes one URL history row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'slugLiveType',
      labelSingular: 'Slug live type',
      labelPlural: 'Slug live types',
      routable: true,
      drafts: false,
    });
    await setUrlPattern(type.id, '/news/{slug}');

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entry.id, 'hello');
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(published.resolvedPath).toBe('/news/hello');

    const renamed = await save({
      entryId: entry.id,
      baseVersion: published.version,
      data: {},
      slug: 'hello-there',
    });
    expect(renamed.slug).toBe('hello-there');
    expect(renamed.resolvedPath).toBe('/news/hello-there');

    const history = await urlHistoryRows(entry.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      oldPath: '/news/hello',
      reason: 'slug_changed',
    });
  });

  it('drafts on, published, a hand-typed slug change is staged: the live path and history stay unchanged until publish', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'slugDraftType',
      labelSingular: 'Slug draft type',
      labelPlural: 'Slug draft types',
      routable: true,
      drafts: true,
    });
    await setUrlPattern(type.id, '/draft-news/{slug}');

    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entry.id, 'hello');
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(published.resolvedPath).toBe('/draft-news/hello');

    const staged = await save({
      entryId: entry.id,
      baseVersion: published.version,
      data: {},
      slug: 'hello-there',
    });
    expect(staged.slug).toBe('hello');
    expect(staged.resolvedPath).toBe('/draft-news/hello');
    expect(await urlHistoryRows(entry.id)).toHaveLength(0);

    const workingCopy = await readWorkingCopy(deps.db, entry.id);
    expect(workingCopy.slug).toBe('hello-there');

    const publishedAgain = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staged.version,
    });
    expect(publishedAgain.resolvedPath).toBe('/draft-news/hello-there');
    const historyAfterPublish = await urlHistoryRows(entry.id);
    expect(historyAfterPublish).toHaveLength(1);
    expect(historyAfterPublish[0]?.oldPath).toBe('/draft-news/hello');
  });

  it('never published, routable, title field set: title-driven generation and suffixing', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'titleSlugType',
      labelSingular: 'Title slug type',
      labelPlural: 'Title slug types',
      routable: true,
      drafts: false,
    });
    await setUrlPattern(type.id, '/blog/{slug}');
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
      data: { title: 'Café Society' },
    });
    const firstSave = await save({
      entryId: entry.id,
      baseVersion: entry.version,
      data: { title: 'Café Society' },
    });
    expect(firstSave.slug).toBe('cafe-society');
    expect(await slugSourceOf(entry.id)).toBe('generated');

    // A second entry with the same title, saved while the first still holds
    // "cafe-society", gets the suffixed clash.
    const entryTwo = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { title: 'Café Society' },
    });
    const savedTwo = await save({
      entryId: entryTwo.id,
      baseVersion: entryTwo.version,
      data: { title: 'Café Society' },
    });
    expect(savedTwo.slug).toBe('cafe-society-2');

    const secondSave = await save({
      entryId: entry.id,
      baseVersion: firstSave.version,
      data: { title: 'New Name' },
    });
    expect(secondSave.slug).toBe('new-name');

    // Reused below (title-freeze and manual-slug tests build on this type).
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: secondSave.version,
    });
    expect(published.slug).toBe('new-name');

    const afterPublishSave = await save({
      entryId: entry.id,
      baseVersion: published.version,
      data: { title: 'Yet Another Name' },
    });
    expect(afterPublishSave.slug).toBe('new-name');

    const conflictError: unknown = await save({
      entryId: entryTwo.id,
      baseVersion: savedTwo.version,
      data: {},
      slug: 'new-name',
    }).catch((caught: unknown) => caught);
    expect(conflictError).toBeInstanceOf(SlugConflictError);

    const invalidError: unknown = await save({
      entryId: entryTwo.id,
      baseVersion: savedTwo.version,
      data: {},
      slug: 'Cafe Society',
    }).catch((caught: unknown) => caught);
    expect(invalidError).toBeInstanceOf(InvalidSlugError);

    const manualSaved = await save({
      entryId: entryTwo.id,
      baseVersion: savedTwo.version,
      data: { title: 'Should Not Matter' },
      slug: 'my-slug',
    });
    expect(manualSaved.slug).toBe('my-slug');
    expect(await slugSourceOf(entryTwo.id)).toBe('manual');

    const afterManual = await save({
      entryId: entryTwo.id,
      baseVersion: manualSaved.version,
      data: { title: 'Changed Title' },
    });
    expect(afterManual.slug).toBe('my-slug');

    const cleared = await save({
      entryId: entryTwo.id,
      baseVersion: afterManual.version,
      data: { title: 'Changed Title' },
      slug: null,
    });
    expect(cleared.slug).toBeNull();
    expect(await slugSourceOf(entryTwo.id)).toBeNull();

    const resumed = await save({
      entryId: entryTwo.id,
      baseVersion: cleared.version,
      data: { title: 'Resumed Title' },
    });
    expect(resumed.slug).toBe('resumed-title');
    expect(await slugSourceOf(entryTwo.id)).toBe('generated');
  });

  it('drafts off, published, a hand-typed slug colliding with another published path throws UrlCollisionError and nothing changes', async () => {
    const typeA = await createContentType(deps, superadmin, {
      key: 'pathCollideTypeA',
      labelSingular: 'Path collide type A',
      labelPlural: 'Path collide types A',
      routable: true,
      drafts: false,
    });
    await setUrlPattern(typeA.id, '/collide/{slug}');
    const entryA = await createEntry(deps, editor, {
      contentTypeKey: typeA.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entryA.id, 'taken-slug');
    await publishEntry(deps, editor, {
      entryId: entryA.id,
      baseVersion: entryA.version,
    });

    const typeB = await createContentType(deps, superadmin, {
      key: 'pathCollideTypeB',
      labelSingular: 'Path collide type B',
      labelPlural: 'Path collide types B',
      routable: true,
      drafts: false,
    });
    await setUrlPattern(typeB.id, '/collide/{slug}');
    const entryB = await createEntry(deps, editor, {
      contentTypeKey: typeB.key,
      locale: 'en',
      data: {},
    });
    await setSlugDirect(entryB.id, 'other-slug');
    const publishedB = await publishEntry(deps, editor, {
      entryId: entryB.id,
      baseVersion: entryB.version,
    });

    const collideError: unknown = await save({
      entryId: entryB.id,
      baseVersion: publishedB.version,
      data: {},
      slug: 'taken-slug',
    }).catch((caught: unknown) => caught);
    expect(collideError).toBeInstanceOf(UrlCollisionError);

    const [unchanged] = await handle.sql<
      { slug: string | null; resolvedPath: string | null }[]
    >`SELECT slug, resolved_path AS "resolvedPath" FROM content_entries WHERE id = ${entryB.id}`;
    expect(unchanged?.slug).toBe('other-slug');
    expect(unchanged?.resolvedPath).toBe('/collide/other-slug');
  });

  it("if the type's drafts setting changes between the permission decision and the transaction, the save throws EntryStateChangedError and writes nothing", async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'raceType',
      labelSingular: 'Race type',
      labelPlural: 'Race types',
      drafts: true,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    // decideSavePermission will read drafts=true, status='published' ->
    // 'entries:edit' (the pending-draft branch).

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: (xid: string) => void = () => undefined;
    const lockTaken = new Promise<string>((resolve) => {
      locked = resolve;
    });

    // Holds a real row lock on the CONTENT TYPE (not the entry): saveEntry's
    // permission decision is an unlocked read that already ran by the time
    // this lock is released, but its own `FOR SHARE` reload of the type row
    // blocks on it. Flipping `drafts` off from underneath the in-flight save
    // never touches the entry row/version, so this can't be mistaken for a
    // StaleVersionError race -- a real publish always bumps the entry's own
    // version too, which would make StaleVersionError fire first instead.
    const holder = handle.sql.begin(async (sql) => {
      const [row] = await sql<{ xid: string }[]>`
        SELECT pg_current_xact_id()::xid::text AS xid
        FROM content_types WHERE id = ${type.id} FOR UPDATE
      `;
      locked(row?.xid ?? '');
      await released;
      await sql`UPDATE content_types SET drafts = false WHERE id = ${type.id}`;
    });

    let savePromise: Promise<unknown> | undefined;
    try {
      const holderXid = await lockTaken;
      savePromise = save({
        entryId: entry.id,
        baseVersion: published.version,
        data: {},
      }).catch((caught: unknown) => caught);

      // A blocked FOR SHARE reload of an already FOR-UPDATE-locked row shows
      // up in pg_locks as a waiting `transactionid` lock request (waiting on
      // the holder's own xid), not a `tuple` lock on the relation. Scoped to
      // that exact xid: pg_locks is server-wide, and this suite's other
      // integration files run against the same Postgres server concurrently,
      // so an unscoped "NOT granted" check can pick up an unrelated lock
      // from a sibling file's own race test and release() before save's own
      // FOR SHARE attempt has even started.
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 1 && Date.now() < deadline) {
        const [row] = await handle.sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_locks
          WHERE NOT granted AND locktype = 'transactionid'
            AND transactionid = ${holderXid}::xid
        `;
        waiting = row?.count ?? 0;
      }
      expect(waiting).toBeGreaterThanOrEqual(1);
    } finally {
      release();
      await holder;
    }

    const result = await savePromise;
    expect(result).toBeInstanceOf(EntryStateChangedError);

    const [row] = await handle.sql<
      { status: string; version: number; draftRevisionId: string | null }[]
    >`
      SELECT status, version, draft_revision_id AS "draftRevisionId"
      FROM content_entries WHERE id = ${entry.id}
    `;
    expect(row?.status).toBe('published');
    expect(row?.version).toBe(published.version);
    expect(row?.draftRevisionId).toBeNull();
  });

  it('D-46, drafts off: saving seo stores all seven properties; omitting seo on the next save leaves the stored set untouched', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'seoLiveType',
      labelSingular: 'SEO live type',
      labelPlural: 'SEO live types',
      seo: true,
      drafts: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const savedSeo = await save({
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
      seo: { title: 'Hello' },
    });
    expect(savedSeo.seo).toEqual({
      title: 'Hello',
      description: null,
      imageAssetId: null,
      canonicalUrl: null,
      noindex: false,
      nofollow: false,
      sitemapInclude: true,
    });

    const savedOmit = await save({
      entryId: entry.id,
      baseVersion: savedSeo.version,
      data: {},
    });
    expect(savedOmit.seo).toEqual(savedSeo.seo);
  });

  it('D-46, drafts on, published: saving seo stages it in the pending draft revision and leaves live seo unchanged until publish', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'seoDraftType',
      labelSingular: 'SEO draft type',
      labelPlural: 'SEO draft types',
      seo: true,
      drafts: true,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    expect(published.seo).toBeNull();

    const stagedSeo = {
      title: 'Staged',
      description: null,
      imageAssetId: null,
      canonicalUrl: null,
      noindex: false,
      nofollow: false,
      sitemapInclude: true,
    };

    const staged = await save({
      entryId: entry.id,
      baseVersion: published.version,
      data: {},
      seo: { title: 'Staged' },
    });
    expect(staged.seo).toBeNull();

    const workingCopy = await readWorkingCopy(deps.db, entry.id);
    expect(workingCopy.seo).toEqual(stagedSeo);

    const publishedAgain = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staged.version,
    });
    expect(publishedAgain.seo).toEqual(stagedSeo);
  });

  it('D-46: saving seo on a type without SEO enabled throws SEO_NOT_ENABLED; an unknown property throws UNKNOWN_PROPERTY', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'seoDisabledType',
      labelSingular: 'SEO disabled type',
      labelPlural: 'SEO disabled types',
      drafts: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const notEnabled: unknown = await save({
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
      seo: { title: 'Hello' },
    }).catch((caught: unknown) => caught);
    expect(notEnabled).toBeInstanceOf(EntrySeoValidationError);
    expect(
      (notEnabled as EntrySeoValidationError).issues.some(
        (issue) => issue.code === 'SEO_NOT_ENABLED',
      ),
    ).toBe(true);

    const unknownProperty: unknown = await save({
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
      seo: { bogus: 'x' },
    }).catch((caught: unknown) => caught);
    expect(unknownProperty).toBeInstanceOf(EntrySeoValidationError);
    expect(
      (unknownProperty as EntrySeoValidationError).issues.some(
        (issue) => issue.code === 'UNKNOWN_PROPERTY',
      ),
    ).toBe(true);

    const [row] = await handle.sql<{ seo: unknown }[]>`
      SELECT seo FROM content_entries WHERE id = ${entry.id}
    `;
    expect(row?.seo).toBeNull();
  });

  it('D-46: two locale rows of one translation group hold independent SEO sets', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'seoGroupType',
      labelSingular: 'SEO group type',
      labelPlural: 'SEO group types',
      seo: true,
      drafts: false,
    });
    const enEntry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const nlEntryId = await insertSiblingLocaleRow(
      type.id,
      enEntry.translationGroup,
      enEntry.publicId,
      'nl',
    );

    const savedNl = await save({
      entryId: nlEntryId,
      baseVersion: 1,
      data: {},
      seo: { title: 'NL title' },
    });
    expect(savedNl.seo).toMatchObject({ title: 'NL title' });

    const [enRow] = await handle.sql<{ seo: unknown }[]>`
      SELECT seo FROM content_entries WHERE id = ${enEntry.id}
    `;
    expect(enRow?.seo).toBeNull();
  });

  it('a stale base version throws StaleVersionError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'staleSaveType',
      labelSingular: 'Stale save type',
      labelPlural: 'Stale save types',
      drafts: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const error: unknown = await save({
      entryId: entry.id,
      baseVersion: entry.version + 999,
      data: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleVersionError);
  });
});
