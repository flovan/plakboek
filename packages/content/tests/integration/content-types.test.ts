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
import {
  computeContentTypeDeleteImpact,
  computeContentTypeKeyRenameImpact,
  ContentTypeConflictError,
  ContentTypeHasEntriesError,
  ContentTypeReferencedError,
  ContentTypeValidationError,
  createContentType,
  deleteContentType,
  getContentTypeByKey,
  PendingDraftsError,
  renameContentTypeKey,
  RoutableInUseError,
  setContentTypeSlug,
  setTitleField,
  TitleFieldError,
  updateContentTypeSettings,
} from '../../src/content-types.js';
import { createEntry } from '../../src/entries.js';
import { addField, listFields } from '../../src/fields.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

describe('Content type settings, slug, key rename, title field and delete (TYPE-02/04/05/07/08/09, D-05, D-09, D-10, D-27)', () => {
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

  async function auditRowsFor(
    action: string,
  ): Promise<{ action: string; outcome: string; after: unknown }[]> {
    return await handle.sql<
      { action: string; outcome: string; after: unknown }[]
    >`SELECT action, outcome, after FROM audit_log WHERE action = ${action} ORDER BY id`;
  }

  async function setEntryStatus(
    entryId: string,
    status: string,
  ): Promise<void> {
    await handle.sql`UPDATE content_entries SET status = ${status} WHERE id = ${entryId}`;
  }

  async function attachPendingDraft(entryId: string): Promise<void> {
    const revisionId = randomUUID();
    const now = clock().toISOString();
    await handle.sql`
      INSERT INTO entry_revisions (id, entry_id, locale, kind, data, field_ids, created_at)
      VALUES (${revisionId}, ${entryId}, 'en', 'save', '{}'::jsonb, '[]'::jsonb, ${now})
    `;
    await handle.sql`UPDATE content_entries SET draft_revision_id = ${revisionId} WHERE id = ${entryId}`;
  }

  it('updateContentTypeSettings persists every changed setting and writes one audit row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'settingsBasic',
      labelSingular: 'Settings basic',
      labelPlural: 'Settings basics',
      routable: true,
    });

    const updated = await updateContentTypeSettings(deps, superadmin, {
      key: type.key,
      labelSingular: 'Renamed basic',
      editLocking: true,
      seo: true,
      revisions: true,
      revisionMode: 'on_publish',
    });

    expect(updated.labelSingular).toBe('Renamed basic');
    expect(updated.editLocking).toBe(true);
    expect(updated.seo).toBe(true);
    expect(updated.revisions).toBe(true);
    expect(updated.revisionMode).toBe('on_publish');

    const allowed = (await auditRowsFor('content-type.update')).filter(
      (row) => row.outcome === 'allowed',
    );
    expect(allowed.length).toBeGreaterThanOrEqual(1);
  });

  it('revisions: true without a revisionMode throws REVISION_MODE_MISMATCH', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'settingsRevisionMismatch',
      labelSingular: 'Revision mismatch',
      labelPlural: 'Revision mismatches',
    });

    const error: unknown = await updateContentTypeSettings(deps, superadmin, {
      key: type.key,
      revisions: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentTypeValidationError);
    expect(
      (error as ContentTypeValidationError).issues.some(
        (issue) => issue.code === 'REVISION_MODE_MISMATCH',
      ),
    ).toBe(true);
  });

  it('turning drafts off while an entry has a pending draft revision throws PendingDraftsError with the count', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'settingsPendingDrafts',
      labelSingular: 'Pending drafts',
      labelPlural: 'Pending drafts',
      drafts: true,
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    await attachPendingDraft(entry.id);

    const error: unknown = await updateContentTypeSettings(deps, superadmin, {
      key: type.key,
      drafts: false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PendingDraftsError);
    expect((error as PendingDraftsError).count).toBe(1);
  });

  it('turning routable off while an entry is published throws RoutableInUseError with the count', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'settingsRoutableInUse',
      labelSingular: 'Routable in use',
      labelPlural: 'Routable in use',
      routable: true,
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    await setEntryStatus(entry.id, 'published');

    const error: unknown = await updateContentTypeSettings(deps, superadmin, {
      key: type.key,
      routable: false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RoutableInUseError);
    expect((error as RoutableInUseError).count).toBe(1);
  });

  it('turning routable on for a singleton type throws SINGLETON_ROUTABLE', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'settingsSingleton',
      labelSingular: 'Settings singleton',
      labelPlural: 'Settings singletons',
      singleton: true,
    });

    const error: unknown = await updateContentTypeSettings(deps, superadmin, {
      key: type.key,
      routable: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentTypeValidationError);
    expect(
      (error as ContentTypeValidationError).issues.some(
        (issue) => issue.code === 'SINGLETON_ROUTABLE',
      ),
    ).toBe(true);
  });

  it('changing singleton on a type with one entry throws ContentTypeHasEntriesError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'settingsSingletonEntries',
      labelSingular: 'Settings singleton entries',
      labelPlural: 'Settings singleton entries',
    });
    await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
    });

    const error: unknown = await updateContentTypeSettings(deps, superadmin, {
      key: type.key,
      singleton: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentTypeHasEntriesError);
    expect((error as ContentTypeHasEntriesError).count).toBe(1);
  });

  it('renameContentTypeKey does not clobber a concurrent options change on a referencing field it does not own (B-CR-01)', async () => {
    const targetType = await createContentType(deps, superadmin, {
      key: 'clobberTarget',
      labelSingular: 'Clobber target',
      labelPlural: 'Clobber targets',
    });
    const holderType = await createContentType(deps, superadmin, {
      key: 'clobberHolder',
      labelSingular: 'Clobber holder',
      labelPlural: 'Clobber holders',
    });
    await addField(deps, superadmin, {
      contentTypeKey: holderType.key,
      key: 'author',
      label: 'Author',
      fieldType: 'reference',
      options: { allowedTypeKeys: [targetType.key], cardinality: 'single' },
    });
    const [fieldRow] = await handle.sql<{ id: string }[]>`
      SELECT id FROM content_type_fields
      WHERE content_type_id = ${holderType.id} AND key = 'author'
    `;
    const fieldId = fieldRow?.id;
    if (fieldId === undefined) {
      throw new Error('expected the reference field row to exist');
    }

    // A second connection holds the referencing field row and only then
    // writes its own options change. The rename owns neither this field nor
    // its content type, so nothing it locks protects this row.
    const blocking = createDb({
      connectionString: testDatabase.connectionString,
      maxConnections: 1,
    });

    let releaseBlocker: () => void = () => {
      throw new Error('releaseBlocker called before it was assigned');
    };
    const blockerSignal = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalLockHeld: (xid: string) => void = () => {
      throw new Error('signalLockHeld called before it was assigned');
    };
    const lockHeld = new Promise<string>((resolve) => {
      signalLockHeld = resolve;
    });

    try {
      const blockingTxPromise = blocking.sql.begin(async (sql) => {
        // Capture the holder's own xid so the wait below can be scoped to it.
        const [held] = await sql`
          SELECT pg_current_xact_id()::xid::text AS xid
          FROM content_type_fields WHERE id = ${fieldId} FOR UPDATE
        `;
        signalLockHeld(held?.xid ?? '');
        await blockerSignal;
        await sql`
          UPDATE content_type_fields
          SET options = options || '{"probeMarker": true}'::jsonb
          WHERE id = ${fieldId}
        `;
      });

      // Only start the rename once the blocker demonstrably holds the row,
      // otherwise the rename can finish first and the race never happens.
      const holderXid = await lockHeld;

      const renamePromise = renameContentTypeKey(deps, superadmin, {
        key: targetType.key,
        newKey: 'clobberRenamed',
      }).catch((caught: unknown) => caught);

      // Wait for the rename to block on the field row it must lock, scoped to
      // the holder's own xid. pg_locks is server-wide and this suite's other
      // integration files share the server, so an unscoped check can be
      // satisfied by a sibling file's race.
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

      releaseBlocker();
      await blockingTxPromise;
      const renameResult: unknown = await renamePromise;
      expect(renameResult).not.toBeInstanceOf(Error);

      // Both writes must survive. The rename rewrites allowedTypeKeys, the
      // concurrent update added probeMarker, and neither may erase the other.
      const [after] = await handle.sql<{ options: Record<string, unknown> }[]>`
        SELECT options FROM content_type_fields WHERE id = ${fieldId}
      `;
      expect(after?.options).toMatchObject({
        allowedTypeKeys: ['clobberRenamed'],
        probeMarker: true,
      });
    } finally {
      await blocking.sql.end({ timeout: 5 });
    }
  });

  it('setContentTypeSlug leaves key unchanged; renameContentTypeKey leaves slug unchanged and writes one history row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'slugKeyArticle',
      labelSingular: 'Slug key article',
      labelPlural: 'Slug key articles',
    });

    const reslugged = await setContentTypeSlug(deps, superadmin, {
      key: type.key,
      slug: 'articles',
    });
    expect(reslugged.slug).toBe('articles');
    expect(reslugged.key).toBe('slugKeyArticle');

    const rekeyed = await renameContentTypeKey(deps, superadmin, {
      key: type.key,
      newKey: 'article',
    });
    expect(rekeyed.key).toBe('article');
    expect(rekeyed.slug).toBe('articles');

    const historyRows = await handle.sql<{ count: string }[]>`
      SELECT count(*) FROM content_type_key_history WHERE content_type_id = ${type.id}
    `;
    expect(Number(historyRows[0]?.count)).toBe(1);

    const bySlug = await setContentTypeSlug(deps, superadmin, {
      key: 'article',
      slug: 'articles',
    });
    expect(bySlug.slug).toBe('articles');
  });

  it('a slug already used by another content type surfaces as ContentTypeConflictError', async () => {
    await createContentType(deps, superadmin, {
      key: 'slugTakenA',
      labelSingular: 'Slug taken A',
      labelPlural: 'Slug taken As',
      slug: 'taken-slug',
    });
    const typeB = await createContentType(deps, superadmin, {
      key: 'slugTakenB',
      labelSingular: 'Slug taken B',
      labelPlural: 'Slug taken Bs',
    });

    const error: unknown = await setContentTypeSlug(deps, superadmin, {
      key: typeB.key,
      slug: 'taken-slug',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentTypeConflictError);
  });

  it('renaming a type key rewrites allowedTypeKeys of a direct reference field and a repeater reference sub-field', async () => {
    const authorType = await createContentType(deps, superadmin, {
      key: 'renameAuthor',
      labelSingular: 'Author',
      labelPlural: 'Authors',
    });
    const blogType = await createContentType(deps, superadmin, {
      key: 'renameBlogPost',
      labelSingular: 'Blog post',
      labelPlural: 'Blog posts',
    });

    await addField(deps, superadmin, {
      contentTypeKey: blogType.key,
      label: 'Author',
      fieldType: 'reference',
      options: {
        allowedTypeKeys: [authorType.key],
        cardinality: 'single',
      },
    });
    await addField(deps, superadmin, {
      contentTypeKey: blogType.key,
      label: 'Contributors',
      fieldType: 'repeater',
      options: {
        fields: [
          {
            key: 'author',
            label: 'Author',
            fieldType: 'reference',
            options: {
              allowedTypeKeys: [authorType.key],
              cardinality: 'single',
            },
          },
        ],
      },
    });

    const impact = await computeContentTypeKeyRenameImpact(
      handle.db,
      authorType.key,
    );
    expect(impact.entryCount).toBe(0);
    expect(impact.referencingFields).toHaveLength(2);
    expect(impact.bindingsUsingKey).toBe(0);

    await renameContentTypeKey(deps, superadmin, {
      key: authorType.key,
      newKey: 'renamePerson',
    });

    const fields = await listFields(handle.db, blogType.id);
    const referenceField = fields.find(
      (field) => field.fieldType === 'reference',
    );
    const repeaterField = fields.find(
      (field) => field.fieldType === 'repeater',
    );
    expect(referenceField).toBeDefined();
    expect(repeaterField).toBeDefined();
    const referenceOptions = referenceField?.options as
      | { allowedTypeKeys: string[] }
      | undefined;
    expect(referenceOptions?.allowedTypeKeys).toEqual(['renamePerson']);
    const repeaterOptions = repeaterField?.options as
      | { fields: { key: string; options: { allowedTypeKeys: string[] } }[] }
      | undefined;
    expect(repeaterOptions?.fields[0]?.options.allowedTypeKeys).toEqual([
      'renamePerson',
    ]);
  });

  it('setTitleField accepts a short_text field on a routable type and rejects wrong shapes', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'titleFieldArticle',
      labelSingular: 'Title field article',
      labelPlural: 'Title field articles',
      routable: true,
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Headline',
      fieldType: 'short_text',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      label: 'Count',
      fieldType: 'integer',
    });

    const updated = await setTitleField(deps, superadmin, {
      key: type.key,
      fieldKey: 'headline',
    });
    expect(updated.titleFieldKey).toBe('headline');

    const cleared = await setTitleField(deps, superadmin, {
      key: type.key,
      fieldKey: null,
    });
    expect(cleared.titleFieldKey).toBeNull();

    const wrongType: unknown = await setTitleField(deps, superadmin, {
      key: type.key,
      fieldKey: 'count',
    }).catch((caught: unknown) => caught);
    expect(wrongType).toBeInstanceOf(TitleFieldError);
    expect((wrongType as TitleFieldError).reason).toBe('WRONG_TYPE');

    const unknownField: unknown = await setTitleField(deps, superadmin, {
      key: type.key,
      fieldKey: 'missing',
    }).catch((caught: unknown) => caught);
    expect(unknownField).toBeInstanceOf(TitleFieldError);
    expect((unknownField as TitleFieldError).reason).toBe('UNKNOWN_FIELD');

    const nonRoutable = await createContentType(deps, superadmin, {
      key: 'titleFieldNonRoutable',
      labelSingular: 'Non routable',
      labelPlural: 'Non routables',
    });
    await addField(deps, superadmin, {
      contentTypeKey: nonRoutable.key,
      label: 'Name',
      fieldType: 'short_text',
    });
    const notRoutable: unknown = await setTitleField(deps, superadmin, {
      key: nonRoutable.key,
      fieldKey: 'name',
    }).catch((caught: unknown) => caught);
    expect(notRoutable).toBeInstanceOf(TitleFieldError);
    expect((notRoutable as TitleFieldError).reason).toBe('NOT_ROUTABLE');
  });

  it('deleteContentType refuses a type holding a trashed entry, reporting the same count beforehand', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'deleteHasTrashed',
      labelSingular: 'Delete has trashed',
      labelPlural: 'Delete has trashed',
    });
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: type.key,
      locale: 'en',
    });
    await setEntryStatus(entry.id, 'trashed');

    const impact = await computeContentTypeDeleteImpact(handle.db, type.key);
    expect(impact.entryCount).toBe(1);

    const error: unknown = await deleteContentType(deps, superadmin, {
      key: type.key,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentTypeHasEntriesError);
    expect((error as ContentTypeHasEntriesError).count).toBe(1);
  });

  it('deleteContentType refuses when it is the only allowed type on a reference field, succeeds and rewrites when a second allowed key exists', async () => {
    const soleTarget = await createContentType(deps, superadmin, {
      key: 'deleteSoleTarget',
      labelSingular: 'Sole target',
      labelPlural: 'Sole targets',
    });
    const soleSource = await createContentType(deps, superadmin, {
      key: 'deleteSoleSource',
      labelSingular: 'Sole source',
      labelPlural: 'Sole sources',
    });
    await addField(deps, superadmin, {
      contentTypeKey: soleSource.key,
      label: 'Target',
      fieldType: 'reference',
      options: { allowedTypeKeys: [soleTarget.key], cardinality: 'single' },
    });

    const refusedError: unknown = await deleteContentType(deps, superadmin, {
      key: soleTarget.key,
    }).catch((caught: unknown) => caught);
    expect(refusedError).toBeInstanceOf(ContentTypeReferencedError);

    const dualTarget = await createContentType(deps, superadmin, {
      key: 'deleteDualTarget',
      labelSingular: 'Dual target',
      labelPlural: 'Dual targets',
    });
    const otherTarget = await createContentType(deps, superadmin, {
      key: 'deleteOtherTarget',
      labelSingular: 'Other target',
      labelPlural: 'Other targets',
    });
    const dualSource = await createContentType(deps, superadmin, {
      key: 'deleteDualSource',
      labelSingular: 'Dual source',
      labelPlural: 'Dual sources',
    });
    await addField(deps, superadmin, {
      contentTypeKey: dualSource.key,
      label: 'Target',
      fieldType: 'reference',
      options: {
        allowedTypeKeys: [dualTarget.key, otherTarget.key],
        cardinality: 'single',
      },
    });

    await deleteContentType(deps, superadmin, { key: dualTarget.key });
    expect(await getContentTypeByKey(handle.db, dualTarget.key)).toBeNull();

    const fields = await listFields(handle.db, dualSource.id);
    const referenceField = fields.find(
      (field) => field.fieldType === 'reference',
    );
    expect(referenceField).toBeDefined();
    const referenceOptions = referenceField?.options as
      | { allowedTypeKeys: string[] }
      | undefined;
    expect(referenceOptions?.allowedTypeKeys).toEqual([otherTarget.key]);
  });

  it('an editor without content-types:edit calling updateContentTypeSettings gets PermissionDeniedError and a denied audit row', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'deniedSettings',
      labelSingular: 'Denied settings',
      labelPlural: 'Denied settings',
    });

    const error: unknown = await updateContentTypeSettings(deps, editor, {
      key: type.key,
      seo: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const denied = (await auditRowsFor('content-type.update')).filter(
      (row) => row.outcome === 'denied',
    );
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });
});
