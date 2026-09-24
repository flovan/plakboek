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
import { addField } from '../../src/fields.js';
import { acquireEditLock, EntryLockedError } from '../../src/locks.js';
import {
  EntryStatusError,
  ScheduleNotInFutureError,
  scheduleEntry,
  trashEntry,
  restoreEntryFromTrash,
  unpublishEntry,
  unscheduleEntry,
} from '../../src/lifecycle.js';
import { publishEntry, readWorkingCopy } from '../../src/publish.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  contributor: ['entries:read', 'entries:create', 'entries:edit'],
});

describe('Entry lifecycle: unpublish, schedule, unschedule, trash and restore-from-trash (D-47, D-48, D-49)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;

  let superadmin: AuditActor;
  let editor: AuditActor;
  let otherEditor: AuditActor;
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

    superadmin = await makeUser('lifecycle-owner@example.com', 'superadmin');
    editor = await makeUser('lifecycle-editor@example.com', 'editor');
    otherEditor = await makeUser(
      'lifecycle-other-editor@example.com',
      'editor',
    );
    contributor = await makeUser(
      'lifecycle-contributor@example.com',
      'contributor',
    );
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function setUrlPatternDirect(
    contentTypeId: string,
    pattern: string | null,
  ): Promise<void> {
    await handle.sql`UPDATE content_types SET url_pattern = ${pattern} WHERE id = ${contentTypeId}`;
  }

  /** Publishes a fresh, routable, title-driven entry and returns it. */
  async function createAndPublishRoutableEntry(input: {
    readonly key: string;
    readonly pattern: string;
    readonly title: string;
    readonly editLocking?: boolean;
  }) {
    const type = await createContentType(deps, superadmin, {
      key: input.key,
      labelSingular: input.key,
      labelPlural: input.key,
      routable: true,
      editLocking: input.editLocking ?? false,
    });
    await setUrlPatternDirect(type.id, input.pattern);
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
      data: { title: input.title },
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });
    return { type, published };
  }

  it('unpublishing collapses a pending draft onto the row and clears draftRevisionId', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'collapsePendingType',
      labelSingular: 'Collapse pending type',
      labelPlural: 'Collapse pending types',
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
      data: { note: 'published text' },
    });
    const published = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    });

    // Stage a pending draft on top of the published row.
    const staged = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: published.version,
      data: { note: 'staged text' },
    });
    expect(staged.draftRevisionId).not.toBeNull();
    expect(staged.data).toEqual({ note: 'published text' });

    const unpublished = await unpublishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staged.version,
    });

    // The staged content is the newest the editor wrote, so unpublishing
    // promotes it onto the row rather than stranding or discarding it.
    expect(unpublished.status).toBe('draft');
    expect(unpublished.draftRevisionId).toBeNull();
    expect(unpublished.data).toEqual({ note: 'staged text' });

    // The working copy and the row now agree, so a later publish cannot
    // resurrect a stale pending revision over a newer live edit.
    const workingCopy = await readWorkingCopy(deps.db, entry.id);
    expect(workingCopy.data).toEqual({ note: 'staged text' });
    expect(workingCopy.pendingRevisionId).toBeNull();

    // A-CR-01 end to end: edit live while unpublished, then republish. The
    // newest edit must win. Before the collapse, the republish read the
    // stranded pending revision and silently discarded this edit.
    const liveEdit = await saveEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: unpublished.version,
      data: { note: 'edited while unpublished' },
    });
    expect(liveEdit.data).toEqual({ note: 'edited while unpublished' });

    const republished = await publishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: liveEdit.version,
    });
    expect(republished.status).toBe('published');
    expect(republished.data).toEqual({ note: 'edited while unpublished' });
  });

  it('unpublishing a published routable entry sets draft, clears resolvedPath, keeps slug/dates/revisions, and writes one URL history row reason unpublished with the old path', async () => {
    const { published } = await createAndPublishRoutableEntry({
      key: 'unpubArticle',
      pattern: '/unpub/{slug}',
      title: 'Unpublish Me',
    });
    expect(published.resolvedPath).toBe('/unpub/unpublish-me');

    const unpublished = await unpublishEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
    });

    expect(unpublished.status).toBe('draft');
    expect(unpublished.resolvedPath).toBeNull();
    expect(unpublished.scheduledAt).toBeNull();
    expect(unpublished.slug).toBe(published.slug);
    expect(unpublished.firstPublishedAt?.getTime()).toBe(
      published.firstPublishedAt?.getTime(),
    );
    expect(unpublished.publishedAt?.getTime()).toBe(
      published.publishedAt?.getTime(),
    );
    expect(unpublished.draftRevisionId).toBe(published.draftRevisionId);
    expect(unpublished.data).toEqual(published.data);

    const historyRows = await handle.sql<
      { old_path: string; reason: string }[]
    >`
      SELECT old_path, reason FROM content_entry_url_history
      WHERE entry_id = ${published.id}
    `;
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]).toMatchObject({
      old_path: '/unpub/unpublish-me',
      reason: 'unpublished',
    });
  });

  it('unpublishing a draft entry throws EntryStatusError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'neverPublishedArticle',
      labelSingular: 'Never published article',
      labelPlural: 'Never published articles',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const error: unknown = await unpublishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EntryStatusError);
    expect(error).toMatchObject({ status: 'draft', operation: 'unpublish' });
  });

  it('an actor without entries:publish gets PermissionDeniedError and a denied row for unpublish', async () => {
    const { published } = await createAndPublishRoutableEntry({
      key: 'unpubPermissionArticle',
      pattern: '/unpub-perm/{slug}',
      title: 'No Permission',
    });

    const error: unknown = await unpublishEntry(deps, contributor, {
      entryId: published.id,
      baseVersion: published.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const denied = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'entry.unpublish' AND outcome = 'denied'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(denied).toHaveLength(1);
  });

  it('after unpublishing, publishing again restores the same path because the frozen date and slug are unchanged', async () => {
    const { published } = await createAndPublishRoutableEntry({
      key: 'republishArticle',
      pattern: '/republish/{slug}',
      title: 'Republish Me',
    });

    const unpublished = await unpublishEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
    });

    const republished = await publishEntry(deps, editor, {
      entryId: published.id,
      baseVersion: unpublished.version,
    });
    expect(republished.resolvedPath).toBe(published.resolvedPath);
    expect(republished.firstPublishedAt?.getTime()).toBe(
      published.firstPublishedAt?.getTime(),
    );
  });

  it('scheduling a draft for now plus one hour sets scheduled and scheduledAt; scheduling for now or the past throws ScheduleNotInFutureError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'scheduleDraftArticle',
      labelSingular: 'Schedule draft article',
      labelPlural: 'Schedule draft articles',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });

    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = await scheduleEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
      scheduledAt: inOneHour,
    });
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt?.getTime()).toBe(inOneHour.getTime());

    const pastEntry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const nowError: unknown = await scheduleEntry(deps, editor, {
      entryId: pastEntry.id,
      baseVersion: pastEntry.version,
      scheduledAt: new Date(),
    }).catch((caught: unknown) => caught);
    expect(nowError).toBeInstanceOf(ScheduleNotInFutureError);

    const pastError: unknown = await scheduleEntry(deps, editor, {
      entryId: pastEntry.id,
      baseVersion: pastEntry.version,
      scheduledAt: new Date(Date.now() - 60 * 60 * 1000),
    }).catch((caught: unknown) => caught);
    expect(pastError).toBeInstanceOf(ScheduleNotInFutureError);
  });

  it('scheduling a published entry keeps published and sets scheduledAt; scheduling a trashed entry throws EntryStatusError', async () => {
    const { published } = await createAndPublishRoutableEntry({
      key: 'schedulePublishedArticle',
      pattern: '/sched-pub/{slug}',
      title: 'Schedule Published',
    });

    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = await scheduleEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
      scheduledAt: inOneHour,
    });
    expect(scheduled.status).toBe('published');
    expect(scheduled.scheduledAt?.getTime()).toBe(inOneHour.getTime());

    const trashed = await trashEntry(deps, editor, {
      entryId: published.id,
      baseVersion: scheduled.version,
    });
    expect(trashed.status).toBe('trashed');

    const error: unknown = await scheduleEntry(deps, editor, {
      entryId: published.id,
      baseVersion: trashed.version,
      scheduledAt: inOneHour,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EntryStatusError);
    expect(error).toMatchObject({ status: 'trashed', operation: 'schedule' });
  });

  it('unscheduling a scheduled entry returns it to draft with scheduledAt null; unscheduling a published entry clears scheduledAt only', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'unscheduleDraftArticle',
      labelSingular: 'Unschedule draft article',
      labelPlural: 'Unschedule draft articles',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const scheduled = await scheduleEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: entry.version,
      scheduledAt: inOneHour,
    });
    expect(scheduled.status).toBe('scheduled');

    const unscheduled = await unscheduleEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: scheduled.version,
    });
    expect(unscheduled.status).toBe('draft');
    expect(unscheduled.scheduledAt).toBeNull();

    const { published } = await createAndPublishRoutableEntry({
      key: 'unschedulePublishedArticle',
      pattern: '/unsched-pub/{slug}',
      title: 'Unschedule Published',
    });
    const scheduledPublished = await scheduleEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
      scheduledAt: inOneHour,
    });
    expect(scheduledPublished.status).toBe('published');

    const unscheduledPublished = await unscheduleEntry(deps, editor, {
      entryId: published.id,
      baseVersion: scheduledPublished.version,
    });
    expect(unscheduledPublished.status).toBe('published');
    expect(unscheduledPublished.scheduledAt).toBeNull();
  });

  it('trashing a published entry sets trashed/trashedAt, clears resolvedPath and scheduledAt, and records one history row reason trashed; restoring returns it to draft with trashedAt null; a user without entries:delete is denied', async () => {
    const { published } = await createAndPublishRoutableEntry({
      key: 'trashArticle',
      pattern: '/trash/{slug}',
      title: 'Trash Me',
    });

    const deniedError: unknown = await trashEntry(deps, contributor, {
      entryId: published.id,
      baseVersion: published.version,
    }).catch((caught: unknown) => caught);
    expect(deniedError).toBeInstanceOf(PermissionDeniedError);
    const denied = await handle.sql<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE action = 'entry.trash' AND outcome = 'denied'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(denied).toHaveLength(1);

    const trashed = await trashEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
    });
    expect(trashed.status).toBe('trashed');
    expect(trashed.trashedAt).not.toBeNull();
    expect(trashed.resolvedPath).toBeNull();
    expect(trashed.scheduledAt).toBeNull();

    const historyRows = await handle.sql<
      { old_path: string; reason: string }[]
    >`
      SELECT old_path, reason FROM content_entry_url_history
      WHERE entry_id = ${published.id} AND reason = 'trashed'
    `;
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]).toMatchObject({
      old_path: '/trash/trash-me',
      reason: 'trashed',
    });

    const restored = await restoreEntryFromTrash(deps, editor, {
      entryId: published.id,
      baseVersion: trashed.version,
    });
    expect(restored.status).toBe('draft');
    expect(restored.trashedAt).toBeNull();
  });

  it('every lifecycle operation with a stale base version throws StaleVersionError', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'staleLifecycleArticle',
      labelSingular: 'Stale lifecycle article',
      labelPlural: 'Stale lifecycle articles',
      routable: false,
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: {},
    });
    const staleVersion = entry.version + 999;

    const unpublishError: unknown = await unpublishEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staleVersion,
    }).catch((caught: unknown) => caught);
    expect(unpublishError).toBeInstanceOf(StaleVersionError);

    const scheduleError: unknown = await scheduleEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staleVersion,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
    }).catch((caught: unknown) => caught);
    expect(scheduleError).toBeInstanceOf(StaleVersionError);

    const unscheduleError: unknown = await unscheduleEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staleVersion,
    }).catch((caught: unknown) => caught);
    expect(unscheduleError).toBeInstanceOf(StaleVersionError);

    const trashError: unknown = await trashEntry(deps, editor, {
      entryId: entry.id,
      baseVersion: staleVersion,
    }).catch((caught: unknown) => caught);
    expect(trashError).toBeInstanceOf(StaleVersionError);

    const restoreError: unknown = await restoreEntryFromTrash(deps, editor, {
      entryId: entry.id,
      baseVersion: staleVersion,
    }).catch((caught: unknown) => caught);
    expect(restoreError).toBeInstanceOf(StaleVersionError);
  });

  it("on an edit-locking type, another user's live lock throws EntryLockedError", async () => {
    const { published } = await createAndPublishRoutableEntry({
      key: 'lockedLifecycleArticle',
      pattern: '/locked-lifecycle/{slug}',
      title: 'Locked Lifecycle',
      editLocking: true,
    });

    await acquireEditLock(deps, otherEditor, { entryId: published.id });

    const error: unknown = await trashEntry(deps, editor, {
      entryId: published.id,
      baseVersion: published.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EntryLockedError);

    const unchanged = await getEntry(deps.db, published.id);
    expect(unchanged?.status).toBe('published');
  });
});
