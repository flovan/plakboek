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
import { createEntry, getEntry } from '../../src/entries.js';
import { addField, deleteField, renameField } from '../../src/fields.js';
import { publishEntry } from '../../src/publish.js';
import {
  computeRestorePreview,
  listRevisions,
  restoreRevision,
  RevisionNotFoundError,
} from '../../src/revisions.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { FieldValidationError } from '../../src/validation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  contributor: ['entries:read', 'entries:create', 'entries:edit'],
});

describe('Restore preview and restore (D-17, T-03-41)', () => {
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

    superadmin = await makeUser('restore-owner@example.com', 'superadmin');
    editor = await makeUser('restore-editor@example.com', 'editor');
    contributor = await makeUser(
      'restore-contributor@example.com',
      'contributor',
    );
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function revisionRowData(revisionId: string): Promise<unknown> {
    const [row] = await handle.sql<{ row: unknown }[]>`
      SELECT to_jsonb(entry_revisions) AS row FROM entry_revisions WHERE id = ${revisionId}
    `;
    return row?.row;
  }

  it('computeRestorePreview maps a rename, drops a deleted field and lists a new field as empty, without writing anything; restoring writes only the mapped keys, bumps the version, audits once, and leaves the revision row unchanged', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'restoreBasicType',
      labelSingular: 'Restore basic type',
      labelPlural: 'Restore basic types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'summary',
      label: 'Summary',
      fieldType: 'short_text',
    });

    const entry = await createEntryWithData(type.key, {
      title: 'Old Title',
      summary: 'Old summary',
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    const revisionId = published.liveRevisionId;
    if (revisionId === null) throw new Error('expected a liveRevisionId');

    await renameField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'title',
      newKey: 'headline',
    });
    await deleteField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'summary',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'intro',
      label: 'Intro',
      fieldType: 'short_text',
    });

    const preview = await computeRestorePreview(deps.db, {
      entryId: entry.id,
      revisionId,
    });
    expect(preview.mappedKeys).toEqual([{ from: 'title', to: 'headline' }]);
    expect(preview.droppedKeys).toEqual(['summary']);
    expect(preview.emptyFields).toEqual(['intro']);
    expect(preview.validationIssues).toEqual([]);
    expect(preview.data).toEqual({ headline: 'Old Title' });

    const beforeRow = await revisionRowData(revisionId);

    const current = await getEntry(deps.db, entry.id);
    if (current === null) throw new Error('entry missing');

    const restored = await restoreRevision(deps, editor, {
      entryId: entry.id,
      baseVersion: current.version,
      revisionId,
    });
    expect(restored.data).toEqual({ headline: 'Old Title' });
    expect(restored.version).toBe(current.version + 1);
    expect(Object.hasOwn(restored.data, 'summary')).toBe(false);
    expect(Object.hasOwn(restored.data, 'intro')).toBe(false);

    const auditRows = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'entry.restore-revision' AND outcome = 'allowed' AND entity_id = ${entry.id}
    `;
    expect(auditRows).toHaveLength(1);

    const afterRow = await revisionRowData(revisionId);
    expect(afterRow).toEqual(beforeRow);
  });

  it('a required field added after the snapshot with no default lists a REQUIRED issue; restoreRevision throws FieldValidationError without changing the entry', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'restoreRequiredType',
      labelSingular: 'Restore required type',
      labelPlural: 'Restore required types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });

    const entry = await createEntryWithData(type.key, { title: 'Hello' });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    const revisionId = published.liveRevisionId;
    if (revisionId === null) throw new Error('expected a liveRevisionId');

    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'category',
      label: 'Category',
      fieldType: 'short_text',
      required: true,
    });

    const preview = await computeRestorePreview(deps.db, {
      entryId: entry.id,
      revisionId,
    });
    expect(
      preview.validationIssues.some(
        (issue) => issue.code === 'REQUIRED' && issue.fieldKey === 'category',
      ),
    ).toBe(true);

    const current = await getEntry(deps.db, entry.id);
    if (current === null) throw new Error('entry missing');
    const beforeData = current.data;

    const error: unknown = await restoreRevision(deps, editor, {
      entryId: entry.id,
      baseVersion: current.version,
      revisionId,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FieldValidationError);

    const after = await getEntry(deps.db, entry.id);
    expect(after?.data).toEqual(beforeData);
    expect(after?.version).toBe(current.version);
  });

  it('on a drafts-on published entry, restoring stages a pending draft and leaves live data unchanged; on drafts-off it goes live and needs entries:publish', async () => {
    const draftsOnType = await createContentType(deps, superadmin, {
      key: 'restoreDraftsOnType',
      labelSingular: 'Restore drafts on type',
      labelPlural: 'Restore drafts on types',
      drafts: true,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: draftsOnType.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });
    const draftsOnEntry = await createEntryWithData(draftsOnType.key, {
      title: 'Original',
    });
    const draftsOnPublished = await publishEntry(deps, editor, {
      entryId: draftsOnEntry.id,
      baseVersion: draftsOnEntry.version,
    });
    const originalRevisionId = draftsOnPublished.liveRevisionId;
    if (originalRevisionId === null) throw new Error('expected liveRevisionId');

    const staged = await saveEntry(deps, editor, {
      entryId: draftsOnEntry.id,
      baseVersion: draftsOnPublished.version,
      data: { title: 'Changed' },
    });
    expect(staged.data).toEqual({ title: 'Original' });

    const restored = await restoreRevision(deps, editor, {
      entryId: draftsOnEntry.id,
      baseVersion: staged.version,
      revisionId: originalRevisionId,
    });
    expect(restored.status).toBe('published');
    expect(restored.data).toEqual({ title: 'Original' });
    expect(restored.draftRevisionId).not.toBeNull();

    const draftsOffType = await createContentType(deps, superadmin, {
      key: 'restoreDraftsOffType',
      labelSingular: 'Restore drafts off type',
      labelPlural: 'Restore drafts off types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: draftsOffType.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });
    const draftsOffEntry = await createEntryWithData(draftsOffType.key, {
      title: 'Original',
    });
    const draftsOffPublished = await publishEntry(deps, editor, {
      entryId: draftsOffEntry.id,
      baseVersion: draftsOffEntry.version,
    });
    const draftsOffRevisionId = draftsOffPublished.liveRevisionId;
    if (draftsOffRevisionId === null)
      throw new Error('expected liveRevisionId');

    const changed = await saveEntry(deps, editor, {
      entryId: draftsOffEntry.id,
      baseVersion: draftsOffPublished.version,
      data: { title: 'Changed' },
    });

    const denied: unknown = await restoreRevision(deps, contributor, {
      entryId: draftsOffEntry.id,
      baseVersion: changed.version,
      revisionId: draftsOffRevisionId,
    }).catch((caught: unknown) => caught);
    expect(denied).toBeInstanceOf(PermissionDeniedError);

    const goesLive = await restoreRevision(deps, editor, {
      entryId: draftsOffEntry.id,
      baseVersion: changed.version,
      revisionId: draftsOffRevisionId,
    });
    expect(goesLive.status).toBe('published');
    expect(goesLive.data).toEqual({ title: 'Original' });
  });

  it('a revision id belonging to another entry throws RevisionNotFoundError; a stale base version throws StaleVersionError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'restoreErrorsType',
      labelSingular: 'Restore errors type',
      labelPlural: 'Restore errors types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'title',
      label: 'Title',
      fieldType: 'short_text',
    });

    const entryA = await createEntryWithData(type.key, { title: 'A' });
    const publishedA = await publishEntry(deps, editor, {
      entryId: entryA.id,
      baseVersion: entryA.version,
    });
    const revisionIdA = publishedA.liveRevisionId;
    if (revisionIdA === null) throw new Error('expected liveRevisionId');

    const entryB = await createEntryWithData(type.key, { title: 'B' });
    const publishedB = await publishEntry(deps, editor, {
      entryId: entryB.id,
      baseVersion: entryB.version,
    });

    const notFoundError: unknown = await restoreRevision(deps, editor, {
      entryId: entryB.id,
      baseVersion: publishedB.version,
      revisionId: revisionIdA,
    }).catch((caught: unknown) => caught);
    expect(notFoundError).toBeInstanceOf(RevisionNotFoundError);

    const previewNotFoundError: unknown = await computeRestorePreview(deps.db, {
      entryId: entryB.id,
      revisionId: revisionIdA,
    }).catch((caught: unknown) => caught);
    expect(previewNotFoundError).toBeInstanceOf(RevisionNotFoundError);

    const staleError: unknown = await restoreRevision(deps, editor, {
      entryId: entryA.id,
      baseVersion: publishedA.version + 999,
      revisionId: revisionIdA,
    }).catch((caught: unknown) => caught);
    expect(staleError).toBeInstanceOf(StaleVersionError);
  });

  it('a snapshot key absent from its field_ids map resolves through content_field_key_history to the renamed field', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'restoreFallbackType',
      labelSingular: 'Restore fallback type',
      labelPlural: 'Restore fallback types',
      drafts: false,
      revisions: true,
      revisionMode: 'on_publish',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'oldName',
      label: 'Old name',
      fieldType: 'short_text',
    });
    const entry = await createEntryWithData(type.key, { oldName: 'Value' });

    // A fixture snapshot whose field_ids map is empty -- simulating one
    // taken before this plan captured field ids -- so the mapping must fall
    // back to content_field_key_history.
    const [revisionRow] = await handle.sql<{ id: string }[]>`
      INSERT INTO entry_revisions (entry_id, locale, kind, data, field_ids, created_at)
      VALUES (${entry.id}, 'en', 'publish', ${JSON.stringify({ oldName: 'Value' })}::jsonb, '{}'::jsonb, ${new Date().toISOString()})
      RETURNING id
    `;
    if (revisionRow === undefined) throw new Error('fixture insert failed');

    await renameField(deps, superadmin, {
      contentTypeKey: type.key,
      fieldKey: 'oldName',
      newKey: 'newName',
    });

    const preview = await computeRestorePreview(deps.db, {
      entryId: entry.id,
      revisionId: revisionRow.id,
    });
    expect(preview.mappedKeys).toEqual([{ from: 'oldName', to: 'newName' }]);
    expect(preview.droppedKeys).toEqual([]);
    expect(preview.data).toEqual({ newName: 'Value' });
  });

  it('listRevisions returns the entrys revisions newest first with kind, createdAt and authorId', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'listRevisionsType',
      labelSingular: 'List revisions type',
      labelPlural: 'List revisions types',
      drafts: true,
      revisions: true,
      revisionMode: 'on_every_save',
    });
    const entry = await createEntryWithData(type.key, {});
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: published.version,
      data: {},
    });

    const revisions = await listRevisions(deps.db, { entryId: entry.id });
    expect(revisions.map((revision) => revision.kind)).toEqual([
      'save',
      'publish',
    ]);
    expect(revisions[0]?.authorId).toBe(editor.userId);
    expect(
      revisions.every((revision) => revision.createdAt instanceof Date),
    ).toBe(true);
  });

  async function createEntryWithData(
    contentTypeKey: string,
    data: Record<string, unknown>,
  ) {
    return await createEntry(deps, editor, {
      contentTypeKey,
      locale: 'en',
      data,
    });
  }
});
