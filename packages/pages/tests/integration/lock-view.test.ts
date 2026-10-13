/**
 * `readPageLockView` (D-27, D-32), proven against real Postgres: what the
 * editor's banner and takeover button need, and nothing more about the holder.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  type AuditActor,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePagesConfig, type PagesDeps } from '../../src/config.js';
import {
  acquirePageLock,
  PAGE_EDIT_LOCK_TTL_SECONDS,
  readPageLockView,
  releasePageLock,
  renewPageLock,
} from '../../src/locks.js';
import { createPage } from '../../src/pages.js';
import { defineBlocks } from '../../src/registry.js';
import { setPageEditLocking } from '../../src/settings.js';
import { createTestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  viewer: ['pages:read'],
});

describe('page lock view (D-27, D-32)', () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: Db;
  let deps: PagesDeps;
  let superadmin: AuditActor;
  let editor: AuditActor;
  let otherEditor: AuditActor;
  let viewer: AuditActor;
  let editorEmail: string;
  let current = new Date('2026-10-13T17:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    const resolver: PermissionResolver = createPermissionResolver(roles);
    const recorder: AuditRecorder = createAuditRecorder({
      db: handle.db,
      resolver,
    });
    const config = definePagesConfig({
      content: defineContentConfig({
        locales: ['en'],
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
    async function makeUser(
      email: string,
      name: string,
      roleKey: string,
    ): Promise<AuditActor> {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }
    editorEmail = 'lock-view-editor@example.com';
    superadmin = await makeUser(
      'lock-view-super@example.com',
      'Sam Super',
      SUPERADMIN_ROLE_KEY,
    );
    editor = await makeUser(editorEmail, 'Edith Editor', 'editor');
    otherEditor = await makeUser(
      'lock-view-other@example.com',
      'Otto Other',
      'editor',
    );
    viewer = await makeUser('lock-view-viewer@example.com', 'Vera', 'viewer');
    deps = { db: handle.db, recorder, resolver, config, now: () => current };
  });

  afterAll(async () => {
    await handle.close();
    await testDatabase.drop();
  });

  async function newPage(): Promise<string> {
    const page = await createPage(deps, superadmin, {
      locale: 'en',
      title: `Lock view ${randomUUID()}`,
    });
    return page.id;
  }

  it('reads a page nobody holds as free', async () => {
    const pageId = await newPage();

    expect(await readPageLockView(deps, editor, { pageId })).toEqual({
      enabled: true,
      state: 'free',
      holder: null,
      canTakeOver: false,
      expiresAt: null,
    });
  });

  it("reads the viewer's own lock as mine, with when it expires", async () => {
    const pageId = await newPage();
    const grant = await acquirePageLock(deps, editor, { pageId });

    const view = await readPageLockView(deps, editor, { pageId });

    expect(view.state).toBe('mine');
    expect(view.holder).toBeNull();
    expect(view.canTakeOver).toBe(false);
    expect(view.expiresAt).toEqual(grant.expiresAt);
    expect(view.expiresAt?.getTime()).toBe(
      grant.lockedAt.getTime() + PAGE_EDIT_LOCK_TTL_SECONDS * 1000,
    );
  });

  it('names the other holder and their last activity, which a renewal moves forward', async () => {
    const pageId = await newPage();
    current = new Date('2026-10-13T17:10:00.000Z');
    await acquirePageLock(deps, editor, { pageId });

    const first = await readPageLockView(deps, otherEditor, { pageId });
    expect(first.state).toBe('other');
    expect(first.holder).toEqual({
      name: 'Edith Editor',
      lastActiveAt: new Date('2026-10-13T17:10:00.000Z'),
    });
    expect(first.expiresAt).toBeNull();

    current = new Date('2026-10-13T17:10:30.000Z');
    await renewPageLock(deps, editor, { pageId });
    const renewed = await readPageLockView(deps, otherEditor, { pageId });
    expect(renewed.holder?.lastActiveAt).toEqual(
      new Date('2026-10-13T17:10:30.000Z'),
    );

    // Once the heartbeat stops and the TTL passes, the page reads as free.
    current = new Date(current.getTime() + PAGE_EDIT_LOCK_TTL_SECONDS * 1000);
    expect((await readPageLockView(deps, otherEditor, { pageId })).state).toBe(
      'free',
    );
  });

  it('offers a takeover to a superadmin over an editor but not to an editor over a superadmin', async () => {
    const pageId = await newPage();
    current = new Date('2026-10-13T17:20:00.000Z');
    await acquirePageLock(deps, editor, { pageId });
    expect(
      (await readPageLockView(deps, superadmin, { pageId })).canTakeOver,
    ).toBe(true);
    await releasePageLock(deps, editor, { pageId });

    await acquirePageLock(deps, superadmin, { pageId });
    expect((await readPageLockView(deps, editor, { pageId })).canTakeOver).toBe(
      false,
    );
  });

  it('reads as disabled and free while locking is switched off', async () => {
    const pageId = await newPage();
    current = new Date('2026-10-13T17:30:00.000Z');
    await acquirePageLock(deps, editor, { pageId });
    await setPageEditLocking(deps, superadmin, { enabled: false });
    try {
      expect(await readPageLockView(deps, otherEditor, { pageId })).toEqual({
        enabled: false,
        state: 'free',
        holder: null,
        canTakeOver: false,
        expiresAt: null,
      });
    } finally {
      await setPageEditLocking(deps, superadmin, { enabled: true });
    }
  });

  it('shows another editor only a name and a time: no email address, role or user id', async () => {
    const pageId = await newPage();
    current = new Date('2026-10-13T17:40:00.000Z');
    await acquirePageLock(deps, editor, { pageId });

    const view = await readPageLockView(deps, otherEditor, { pageId });

    expect(Object.keys(view).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'canTakeOver',
      'enabled',
      'expiresAt',
      'holder',
      'state',
    ]);
    expect(
      Object.keys(view.holder ?? {}).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['lastActiveAt', 'name']);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(editorEmail);
    expect(serialised).not.toContain(editor.userId);
    expect(serialised).not.toContain('role_key');
    expect(serialised).not.toContain(editor.roleKey);
  });

  it('refuses a viewer without pages:edit, recording the denial', async () => {
    const pageId = await newPage();
    const [before] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.lock-view' AND outcome = 'denied'
    `;

    const error: unknown = await readPageLockView(deps, viewer, {
      pageId,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PermissionDeniedError);
    const [after] = await handle.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log
      WHERE action = 'page.lock-view' AND outcome = 'denied'
    `;
    expect(Number(after?.count)).toBe(Number(before?.count) + 1);
  });
});
