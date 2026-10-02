/**
 * Which cache tags each write path purges, and when (D-18, D-19): the exact
 * tag list per trigger, that a refused or denied write registers nothing,
 * that the purge runs only after the commit is visible to another
 * connection, and that a failing purge layer never fails the write. Proven
 * against real Postgres with a spy invalidator.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  type AfterCommitFailure,
  type AuditActor,
  type AuditDatabase,
  type AuditRecorder,
} from '@plakboek/auth';
import type { CacheInvalidator } from '@plakboek/cache';
import { defineContentConfig } from '@plakboek/content';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  deletePagePermanently,
  PageStatusError,
  restorePageFromTrash,
  trashPage,
  unpublishPage,
} from '../../src/lifecycle.js';
import { createPage, getPage, StalePageVersionError } from '../../src/pages.js';
import { publishPage } from '../../src/publish.js';
import { defineBlocks } from '../../src/registry.js';
import type { PageRecord } from '../../src/types.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({ ...defaultRoles, viewer: ['pages:read'] });

const config = definePagesConfig({
  content: defineContentConfig({
    locales: ['en', 'nl'],
    defaultLocale: 'en',
    timezone: 'UTC',
  }),
  blocks: defineBlocks([
    {
      key: 'section',
      kind: 'section',
      editor: { label: 'Section' },
      schemaVersion: 1,
      properties: {},
    },
  ]),
});

const tagOf = (page: { readonly id: string }): string => `page:${page.id}`;
const sorted = (tags: readonly string[]): string[] => [...tags].sort();

describe('purge registration: tags per trigger, after commit only (D-18, D-19)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let probe: Db;
  let db: AuditDatabase;
  let deps: PagesDeps;
  let actor: AuditActor;
  let viewer: AuditActor;
  let resolver: PermissionResolver;
  // Every `purge` call the spy invalidator received, one tag array per call.
  let calls: string[][] = [];
  // Set by a test that wants the spy to look at the database when it runs.
  let onPurge: (() => Promise<void>) | null = null;
  let afterCommitFailures: AfterCommitFailure[] = [];

  const spy: CacheInvalidator = {
    async purge(tags) {
      calls.push([...tags]);
      await onPurge?.();
    },
  };

  function depsWith(
    invalidator: CacheInvalidator | undefined,
    onAfterCommitFailed?: (failure: AfterCommitFailure) => void,
  ): PagesDeps {
    const recorder: AuditRecorder = createAuditRecorder({
      db,
      resolver,
      ...(onAfterCommitFailed === undefined ? {} : { onAfterCommitFailed }),
    });
    return {
      db,
      recorder,
      resolver,
      config,
      ...(invalidator === undefined ? {} : { invalidator }),
    };
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });
    probe = createDb({ connectionString: testDatabase.connectionString });
    db = handle.db;
    resolver = createPermissionResolver(roles);

    const superadminUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'purge-owner@example.com',
      name: 'Owner',
      roleKey: SUPERADMIN_ROLE_KEY,
    });
    actor = { userId: superadminUser.userId, roleKey: superadminUser.roleKey };
    const viewerUser = await createUserWithRole(db, {
      id: randomUUID(),
      email: 'purge-viewer@example.com',
      name: 'Viewer',
      roleKey: 'viewer',
    });
    viewer = { userId: viewerUser.userId, roleKey: viewerUser.roleKey };

    deps = depsWith(spy, (failure) => {
      afterCommitFailures.push(failure);
    });
  });

  afterAll(async () => {
    await probe.close();
    await handle.close();
    await testDatabase.drop();
  });

  beforeEach(() => {
    calls = [];
    onPurge = null;
    afterCommitFailures = [];
  });

  async function draft(
    slug: string,
    parent?: PageRecord,
    locale = 'en',
  ): Promise<PageRecord> {
    return await createPage(deps, actor, {
      locale,
      title: slug,
      slug,
      ...(parent === undefined ? {} : { parentPageId: parent.id }),
    });
  }

  async function reload(page: PageRecord): Promise<PageRecord> {
    const fresh = await getPage(db, page.id);
    if (fresh === null) throw new Error(`page ${page.id} vanished`);
    return fresh;
  }

  async function published(
    slug: string,
    parent?: PageRecord,
    locale = 'en',
  ): Promise<PageRecord> {
    const page = await draft(slug, parent, locale);
    await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });
    return await reload(page);
  }

  it('publishPage purges exactly the published page tag', async () => {
    const page = await draft('purge-publish');
    await publishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });

    expect(calls).toEqual([[tagOf(page)]]);
  });

  it('unpublishPage purges the page tag, and only after the commit is visible to another connection', async () => {
    const page = await published('purge-unpublish');
    calls = [];
    const seen: string[] = [];
    onPurge = async () => {
      const rows = await probe.sql<{ status: string }[]>`
        SELECT status FROM pages WHERE id = ${page.id}
      `;
      seen.push(rows[0]?.status ?? 'missing');
    };

    await unpublishPage(deps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });

    expect(calls).toEqual([[tagOf(page)]]);
    expect(seen).toEqual(['draft']);
  });

  it('trashPage purges every page in the subtree, including a draft grandchild', async () => {
    const parent = await published('purge-trash');
    const child = await published('child', parent);
    const grandchild = await draft('grandchild', child);
    calls = [];

    await trashPage(deps, actor, {
      pageId: parent.id,
      baseVersion: (await reload(parent)).version,
    });

    expect(calls).toHaveLength(1);
    expect(sorted(calls[0]!)).toEqual(
      sorted([tagOf(parent), tagOf(child), tagOf(grandchild)]),
    );
  });

  it('restorePageFromTrash purges the restored pages', async () => {
    const parent = await published('purge-restore');
    const child = await published('child', parent);
    await trashPage(deps, actor, {
      pageId: parent.id,
      baseVersion: (await reload(parent)).version,
    });
    calls = [];

    await restorePageFromTrash(deps, actor, {
      pageId: parent.id,
      baseVersion: (await reload(parent)).version,
    });

    expect(calls).toHaveLength(1);
    expect(sorted(calls[0]!)).toEqual(sorted([tagOf(parent), tagOf(child)]));
  });

  it('deletePagePermanently purges every page in the deleted subtree', async () => {
    const parent = await published('purge-delete');
    const child = await draft('child', parent);
    calls = [];

    await deletePagePermanently(deps, actor, {
      pageId: parent.id,
      baseVersion: parent.version,
    });

    expect(calls).toHaveLength(1);
    expect(sorted(calls[0]!)).toEqual(sorted([tagOf(parent), tagOf(child)]));
  });

  it('a stale base version, a status refusal and a denied actor each leave the spy uncalled', async () => {
    const page = await published('purge-refused');
    calls = [];

    await expect(
      unpublishPage(deps, actor, {
        pageId: page.id,
        baseVersion: page.version - 1,
      }),
    ).rejects.toBeInstanceOf(StalePageVersionError);

    await expect(
      unpublishPage(deps, viewer, {
        pageId: page.id,
        baseVersion: page.version,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const trashed = await draft('purge-refused-trashed');
    await trashPage(deps, actor, {
      pageId: trashed.id,
      baseVersion: trashed.version,
    });
    calls = [];
    await expect(
      trashPage(deps, actor, {
        pageId: trashed.id,
        baseVersion: (await reload(trashed)).version,
      }),
    ).rejects.toBeInstanceOf(PageStatusError);

    expect(calls).toEqual([]);
  });

  it('with no invalidator in the deps, every transition still succeeds', async () => {
    const bare = depsWith(undefined);
    const parent = await published('purge-bare');
    const child = await published('child', parent);
    calls = [];

    const unpublished = await unpublishPage(bare, actor, {
      pageId: child.id,
      baseVersion: child.version,
    });
    expect(unpublished.status).toBe('draft');
    const trashedRecord = await trashPage(bare, actor, {
      pageId: parent.id,
      baseVersion: (await reload(parent)).version,
    });
    expect(trashedRecord.status).toBe('trashed');
    const restored = await restorePageFromTrash(bare, actor, {
      pageId: parent.id,
      baseVersion: trashedRecord.version,
    });
    expect(restored.status).toBe('draft');
    await deletePagePermanently(bare, actor, {
      pageId: parent.id,
      baseVersion: restored.version,
    });

    expect(calls).toEqual([]);
  });

  it('a purge layer that always rejects never fails the write and reaches onAfterCommitFailed once', async () => {
    const failing: CacheInvalidator = {
      async purge() {
        throw new Error('layer down');
      },
    };
    const failures: AfterCommitFailure[] = [];
    const failingDeps = depsWith(failing, (failure) => {
      failures.push(failure);
    });
    const page = await published('purge-failing');

    const unpublished = await unpublishPage(failingDeps, actor, {
      pageId: page.id,
      baseVersion: page.version,
    });

    expect(unpublished.status).toBe('draft');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.action).toBe('page.unpublish');
    expect(afterCommitFailures).toEqual([]);
  });
});
