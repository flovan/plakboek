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
import {
  computeTranslatableChangeImpact,
  setFieldTranslatable,
} from '../../src/field-translatable.js';
import { addField } from '../../src/fields.js';
import { acquireEditLock, EntryLockedError } from '../../src/locks.js';
import { publishEntry } from '../../src/publish.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { createTranslation } from '../../src/translations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

type RawEntryRow = {
  readonly data: Record<string, unknown>;
  readonly version: number;
  readonly status: string;
  readonly draftRevisionId: string | null;
  readonly lockedBy: string | null;
};

describe('Shared (non-translatable) field sync on save and on the translatable toggle (D-19, D-23, D-25, D-26, D-45)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;

  let superadmin: AuditActor;
  let editorA: AuditActor;
  let editorB: AuditActor;

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
    editorA = await makeUser('editor-a@example.com', 'editor');
    editorB = await makeUser('editor-b@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function rawEntry(entryId: string): Promise<RawEntryRow> {
    const [row] = await handle.sql<RawEntryRow[]>`
      SELECT data, version, status,
        draft_revision_id AS "draftRevisionId", locked_by AS "lockedBy"
      FROM content_entries WHERE id = ${entryId}
    `;
    if (row === undefined) {
      throw new Error(`no entry row found for "${entryId}"`);
    }
    return row;
  }

  async function saveRevisionCount(
    entryId: string,
    kind: 'save' | 'publish' = 'save',
  ): Promise<number> {
    const [row] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entry_revisions
      WHERE entry_id = ${entryId} AND kind = ${kind}
    `;
    return row?.count ?? 0;
  }

  async function pendingRevisionData(entryId: string): Promise<unknown> {
    const [row] = await handle.sql<{ data: unknown }[]>`
      SELECT r.data AS data FROM content_entries e
      JOIN entry_revisions r ON r.id = e.draft_revision_id
      WHERE e.id = ${entryId}
    `;
    return row?.data;
  }

  async function auditRowsForEntity(
    action: string,
    entityId: string,
  ): Promise<{ after: unknown }[]> {
    return await handle.sql<{ after: unknown }[]>`
      SELECT after FROM audit_log
      WHERE action = ${action} AND entity_id = ${entityId}
      ORDER BY id
    `;
  }

  async function lastAuditRow(
    action: string,
  ): Promise<{ outcome: string; after: unknown } | undefined> {
    const [row] = await handle.sql<{ outcome: string; after: unknown }[]>`
      SELECT outcome, after FROM audit_log
      WHERE action = ${action}
      ORDER BY id DESC
      LIMIT 1
    `;
    return row;
  }

  async function insertLocaleFixtureRow(
    contentTypeId: string,
    translationGroup: string,
    publicId: number,
    locale: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await handle.sql`
      INSERT INTO content_entries
        (id, content_type_id, translation_group, public_id, locale, status, data, version, created_at, updated_at)
      VALUES
        (${id}, ${contentTypeId}, ${translationGroup}, ${publicId}, ${locale}, 'draft', ${JSON.stringify(data)}::jsonb, 1, ${now}, ${now})
    `;
    return id;
  }

  // ---------------------------------------------------------------------
  // Task 1: shared-field sync on save
  // ---------------------------------------------------------------------

  it('drafts off, on-every-save: a shared sku edit syncs to en, bumps both versions, records a save revision on each, and audits originLocale/syncedLocales', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'sharedLiveType',
      labelSingular: 'Shared live type',
      labelPlural: 'Shared live types',
      revisions: true,
      revisionMode: 'on_every_save',
      editLocking: true,
    });
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

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { title: 'nl titel', sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: { title: 'en title' },
    });
    expect(enEntry.data.sku).toBe('A-1');

    const savedNl = await saveEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
      data: { title: 'nl titel', sku: 'B-2' },
    });
    expect(savedNl.version).toBe(nlEntry.version + 1);
    expect(savedNl.data.sku).toBe('B-2');

    const enRow = await rawEntry(enEntry.id);
    expect(enRow.data.sku).toBe('B-2');
    expect(enRow.version).toBe(enEntry.version + 1);

    expect(await saveRevisionCount(nlEntry.id, 'save')).toBe(1);
    expect(await saveRevisionCount(enEntry.id, 'save')).toBe(1);

    const auditRows = await auditRowsForEntity('entry.save', nlEntry.id);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.after).toMatchObject({
      originLocale: 'nl',
      syncedLocales: ['en'],
    });
  });

  it('drafts on with en published: the shared edit leaves live data unchanged and stages a pending draft on en holding the new value', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'sharedDraftType',
      labelSingular: 'Shared draft type',
      labelPlural: 'Shared draft types',
      drafts: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'sku',
      label: 'SKU',
      fieldType: 'short_text',
      translatable: false,
    });

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: {},
    });
    const enPublished = await publishEntry(deps, editorA, {
      entryId: enEntry.id,
      baseVersion: enEntry.version,
    });
    expect(enPublished.data.sku).toBe('A-1');

    const savedNl = await saveEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
      data: { sku: 'B-2' },
    });
    expect(savedNl.data.sku).toBe('B-2');

    const enRow = await rawEntry(enEntry.id);
    expect(enRow.data.sku).toBe('A-1');
    expect(enRow.status).toBe('published');
    expect(enRow.draftRevisionId).not.toBeNull();

    const pending = await pendingRevisionData(enEntry.id);
    expect((pending as Record<string, unknown>).sku).toBe('B-2');
  });

  it('saving only translatable data leaves the sibling row completely untouched', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'onlyTranslatableType',
      labelSingular: 'Only translatable type',
      labelPlural: 'Only translatable types',
    });
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

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { title: 'nl', sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: { title: 'en' },
    });
    const enBefore = await rawEntry(enEntry.id);

    const savedNl = await saveEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
      data: { title: 'nl updated', sku: 'A-1' },
    });
    expect(savedNl.data.title).toBe('nl updated');

    const enAfter = await rawEntry(enEntry.id);
    expect(enAfter.version).toBe(enBefore.version);
    expect(enAfter.data).toEqual(enBefore.data);
  });

  it('with en locked by another user, a shared sku edit in nl is refused and neither row changes; a translatable-only edit still succeeds', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'lockedSyncType',
      labelSingular: 'Locked sync type',
      labelPlural: 'Locked sync types',
      editLocking: true,
    });
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

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { title: 'nl', sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: { title: 'en' },
    });

    await acquireEditLock(deps, editorB, { entryId: enEntry.id });

    const lockedError: unknown = await saveEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
      data: { title: 'nl', sku: 'B-2' },
    }).catch((caught: unknown) => caught);
    expect(lockedError).toBeInstanceOf(EntryLockedError);

    const nlUnchanged = await rawEntry(nlEntry.id);
    expect(nlUnchanged.version).toBe(nlEntry.version);
    const enUnchanged = await rawEntry(enEntry.id);
    expect(enUnchanged.version).toBe(enEntry.version);

    const savedNl = await saveEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
      data: { title: 'nl updated', sku: 'A-1' },
    });
    expect(savedNl.version).toBe(nlEntry.version + 1);
  });

  it('a fixture row in a disabled locale (de) is left untouched by shared-field sync (D-25)', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'removedLocaleType',
      labelSingular: 'Removed locale type',
      labelPlural: 'Removed locale types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'sku',
      label: 'SKU',
      fieldType: 'short_text',
      translatable: false,
    });

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: {},
    });
    const deEntryId = await insertLocaleFixtureRow(
      type.id,
      nlEntry.translationGroup,
      nlEntry.publicId,
      'de',
      { sku: 'A-1' },
    );

    await saveEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
      data: { sku: 'B-2' },
    });

    const enAfter = await rawEntry(enEntry.id);
    expect(enAfter.data.sku).toBe('B-2');

    const deAfter = await rawEntry(deEntryId);
    expect(deAfter.data.sku).toBe('A-1');
    expect(deAfter.version).toBe(1);
  });

  it('concurrent shared saves from two locales settle without a deadlock error', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'concurrentSyncType',
      labelSingular: 'Concurrent sync type',
      labelPlural: 'Concurrent sync types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'sku',
      label: 'SKU',
      fieldType: 'short_text',
      translatable: false,
    });

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: {},
    });

    const results = await Promise.allSettled([
      saveEntry(deps, editorA, {
        entryId: nlEntry.id,
        baseVersion: nlEntry.version,
        data: { sku: 'X' },
      }),
      saveEntry(deps, editorA, {
        entryId: enEntry.id,
        baseVersion: enEntry.version,
        data: { sku: 'Y' },
      }),
    ]);

    const rejected = results.filter(
      (settled): settled is PromiseRejectedResult =>
        settled.status === 'rejected',
    );
    const fulfilled = results.filter(
      (settled) => settled.status === 'fulfilled',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StaleVersionError);
  });

  // ---------------------------------------------------------------------
  // Task 2: toggling a field's translatable flag
  // ---------------------------------------------------------------------

  it('turning translatable on for a non-translatable field with data only flips the flag; afterwards a save no longer syncs it', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'toggleOnType',
      labelSingular: 'Toggle on type',
      labelPlural: 'Toggle on types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'sku',
      label: 'SKU',
      fieldType: 'short_text',
      translatable: false,
    });

    const nlEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'nl',
      data: { sku: 'A-1' },
    });
    const enEntry = await createTranslation(deps, editorA, {
      sourceEntryId: nlEntry.id,
      locale: 'en',
      data: {},
    });
    expect(enEntry.data.sku).toBe('A-1');

    const nlBefore = await rawEntry(nlEntry.id);
    const enBefore = await rawEntry(enEntry.id);

    const field = await setFieldTranslatable(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'sku',
      translatable: true,
    });
    expect(field.translatable).toBe(true);

    const nlAfterToggle = await rawEntry(nlEntry.id);
    const enAfterToggle = await rawEntry(enEntry.id);
    expect(nlAfterToggle.version).toBe(nlBefore.version);
    expect(enAfterToggle.version).toBe(enBefore.version);

    const savedEn = await saveEntry(deps, editorA, {
      entryId: enEntry.id,
      baseVersion: enEntry.version,
      data: { sku: 'EN-only' },
    });
    expect(savedEn.data.sku).toBe('EN-only');

    const nlUnaffected = await rawEntry(nlEntry.id);
    expect(nlUnaffected.data.sku).toBe('A-1');
  });

  it('turning translatable off with en "A" and nl "B" reports en as the winner, applies it to both, and writes one audit row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'toggleOffDiffType',
      labelSingular: 'Toggle off diff type',
      labelPlural: 'Toggle off diff types',
      revisions: true,
      revisionMode: 'on_every_save',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'summary',
      label: 'Summary',
      fieldType: 'short_text',
    });

    const enEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { summary: 'A' },
    });
    const nlEntry = await createTranslation(deps, editorA, {
      sourceEntryId: enEntry.id,
      locale: 'nl',
      data: { summary: 'B' },
    });

    const impact = await computeTranslatableChangeImpact(deps.db, deps.config, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });
    expect(impact.groupsAffected).toBe(1);
    expect(impact.groups[0]).toMatchObject({
      translationGroup: enEntry.translationGroup,
      winnerLocale: 'en',
      differingLocales: ['nl'],
    });

    const field = await setFieldTranslatable(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });
    expect(field.translatable).toBe(false);

    const enAfter = await rawEntry(enEntry.id);
    const nlAfter = await rawEntry(nlEntry.id);
    expect(enAfter.data.summary).toBe('A');
    expect(enAfter.version).toBe(enEntry.version);
    expect(nlAfter.data.summary).toBe('A');
    expect(nlAfter.version).toBe(nlEntry.version + 1);

    expect(await saveRevisionCount(nlEntry.id, 'save')).toBe(1);
    expect(await saveRevisionCount(enEntry.id, 'save')).toBe(0);

    const auditRow = await lastAuditRow('field.set-translatable');
    expect(auditRow?.after).toMatchObject({
      translatable: false,
      groupsAffected: 1,
    });
  });

  it('with en holding no value and nl holding "B", nl wins and en receives it', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'toggleOffEmptyWinnerType',
      labelSingular: 'Toggle off empty winner type',
      labelPlural: 'Toggle off empty winner types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'summary',
      label: 'Summary',
      fieldType: 'short_text',
    });

    const enEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const nlEntry = await createTranslation(deps, editorA, {
      sourceEntryId: enEntry.id,
      locale: 'nl',
      data: { summary: 'B' },
    });

    const impact = await computeTranslatableChangeImpact(deps.db, deps.config, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });
    expect(impact.groups[0]).toMatchObject({
      winnerLocale: 'nl',
      differingLocales: ['en'],
    });

    await setFieldTranslatable(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });

    const enAfter = await rawEntry(enEntry.id);
    expect(enAfter.data.summary).toBe('B');
    const nlAfter = await rawEntry(nlEntry.id);
    expect(nlAfter.version).toBe(nlEntry.version);
  });

  it('a group whose rows already agree is not rewritten and its versions do not change', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'toggleOffAgreeType',
      labelSingular: 'Toggle off agree type',
      labelPlural: 'Toggle off agree types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'summary',
      label: 'Summary',
      fieldType: 'short_text',
    });

    const enEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { summary: 'Same' },
    });
    const nlEntry = await createTranslation(deps, editorA, {
      sourceEntryId: enEntry.id,
      locale: 'nl',
      data: { summary: 'Same' },
    });

    const impact = await computeTranslatableChangeImpact(deps.db, deps.config, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });
    expect(impact.groupsAffected).toBe(0);

    await setFieldTranslatable(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });

    const enAfter = await rawEntry(enEntry.id);
    const nlAfter = await rawEntry(nlEntry.id);
    expect(enAfter.version).toBe(enEntry.version);
    expect(nlAfter.version).toBe(nlEntry.version);
  });

  it('a drafts-on published differing row receives the winner as a new pending draft, live data unchanged', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'toggleOffDraftType',
      labelSingular: 'Toggle off draft type',
      labelPlural: 'Toggle off draft types',
      drafts: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'summary',
      label: 'Summary',
      fieldType: 'short_text',
    });

    const enEntry = await createEntry(deps, editorA, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { summary: 'A' },
    });
    await publishEntry(deps, editorA, {
      entryId: enEntry.id,
      baseVersion: enEntry.version,
    });
    const nlEntry = await createTranslation(deps, editorA, {
      sourceEntryId: enEntry.id,
      locale: 'nl',
      data: { summary: 'B' },
    });
    await publishEntry(deps, editorA, {
      entryId: nlEntry.id,
      baseVersion: nlEntry.version,
    });

    await setFieldTranslatable(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    });

    const nlAfter = await rawEntry(nlEntry.id);
    expect(nlAfter.data.summary).toBe('B');
    expect(nlAfter.draftRevisionId).not.toBeNull();

    const pending = await pendingRevisionData(nlEntry.id);
    expect((pending as Record<string, unknown>).summary).toBe('A');
  });

  it('a user without content-types:edit gets PermissionDeniedError and a denied audit row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'toggleOffPermissionType',
      labelSingular: 'Toggle off permission type',
      labelPlural: 'Toggle off permission types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'summary',
      label: 'Summary',
      fieldType: 'short_text',
    });

    const error: unknown = await setFieldTranslatable(deps, editorA, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
      translatable: false,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const denied = await lastAuditRow('field.set-translatable');
    expect(denied?.outcome).toBe('denied');
  });
});
