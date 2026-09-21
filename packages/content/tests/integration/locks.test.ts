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
  acquireEditLock,
  EDIT_LOCK_TTL_SECONDS,
  EditLockingDisabledError,
  EntryLockedError,
  LockStateChangedError,
  LockTakeoverForbiddenError,
  releaseEditLock,
  renewEditLock,
  takeOverEditLock,
} from '../../src/locks.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles({
  ...defaultRoles,
  author: ['entries:read', 'entries:edit'],
  viewer: ['entries:read'],
});

/** A controllable clock: `deps.now` reads `current`, and `advance` moves it
 * forward by a number of seconds. */
function makeClock(startIso: string) {
  let current = new Date(startIso);
  return {
    now: (): Date => current,
    advance(seconds: number): void {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

type AuditRow = {
  action: string;
  outcome: string;
  after: unknown;
};

describe('Edit locking, heartbeat lapse, takeover and the save-time refusal (TYPE-05, D-43, D-44, D-45)', () => {
  let testDatabase: TestDatabase;
  let handle: Db;
  let deps: ContentDeps;
  let resolver: PermissionResolver;
  let recorder: AuditRecorder;
  let clock: ReturnType<typeof makeClock>;

  let superadmin: AuditActor;
  let editorA: AuditActor;
  let editorB: AuditActor;
  let admin: AuditActor;
  let author: AuditActor;
  let viewer: AuditActor;

  let typeLockingId: string;
  let typeLockingKey: string;
  let typeNoLockingKey: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await runMigrations({ connectionString: testDatabase.connectionString });
    handle = createDb({ connectionString: testDatabase.connectionString });

    resolver = createPermissionResolver(roles);
    recorder = createAuditRecorder({ db: handle.db, resolver });
    clock = makeClock('2026-09-16T12:00:00.000Z');

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
    editorA = await makeUser('editor-a@example.com', 'editor');
    editorB = await makeUser('editor-b@example.com', 'editor');
    admin = await makeUser('admin@example.com', 'admin');
    author = await makeUser('author@example.com', 'author');
    viewer = await makeUser('viewer@example.com', 'viewer');

    const typeLocking = await createContentType(deps, superadmin, {
      key: 'lockingArticle',
      labelSingular: 'Locking article',
      labelPlural: 'Locking articles',
      editLocking: true,
    });
    typeLockingId = typeLocking.id;
    typeLockingKey = typeLocking.key;

    const typeNoLocking = await createContentType(deps, superadmin, {
      key: 'openArticle',
      labelSingular: 'Open article',
      labelPlural: 'Open articles',
    });
    typeNoLockingKey = typeNoLocking.key;
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  async function auditRowsFor(action: string): Promise<AuditRow[]> {
    return await handle.sql<AuditRow[]>`
      SELECT action, outcome, after
      FROM audit_log
      WHERE action = ${action}
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
    const now = clock.now().toISOString();
    await handle.sql`
      INSERT INTO content_entries
        (id, content_type_id, translation_group, public_id, locale, status, data, version, created_at, updated_at)
      VALUES
        (${id}, ${contentTypeId}, ${translationGroup}, ${publicId}, ${locale}, 'draft', '{}'::jsonb, 1, ${now}, ${now})
    `;
    return id;
  }

  it('a user whose role lacks entries:edit gets PermissionDeniedError and a denied audit row on acquire', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });

    const error: unknown = await acquireEditLock(deps, viewer, {
      entryId: entry.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermissionDeniedError);

    const denied = (await auditRowsFor('entry.lock-acquire')).filter(
      (row) => row.outcome === 'denied',
    );
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it('on a type without edit locking, acquireEditLock throws EditLockingDisabledError and a save succeeds despite fixture-set lock columns', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeNoLockingKey,
      locale: 'en',
    });

    const error: unknown = await acquireEditLock(deps, editorA, {
      entryId: entry.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EditLockingDisabledError);

    await handle.sql`
      UPDATE content_entries
      SET locked_by = ${editorA.userId}, locked_at = ${clock.now().toISOString()}
      WHERE id = ${entry.id}
    `;

    const saved = await saveEntry(deps, editorB, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
    });
    expect(saved.version).toBe(entry.version + 1);
  });

  it('A acquires the en row; B is refused by save and by acquire; B can still save the nl row of the same group', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });

    const grant = await acquireEditLock(deps, editorA, {
      entryId: entry.id,
    });
    expect(grant.lockedAt.getTime()).toBe(clock.now().getTime());
    expect(grant.expiresAt.getTime()).toBe(
      clock.now().getTime() + EDIT_LOCK_TTL_SECONDS * 1000,
    );

    const saveError: unknown = await saveEntry(deps, editorB, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
    }).catch((caught: unknown) => caught);
    expect(saveError).toBeInstanceOf(EntryLockedError);
    expect(saveError).toMatchObject({
      entryId: entry.id,
      locale: 'en',
      holderUserId: editorA.userId,
    });

    const [unchanged] = await handle.sql<{ version: number }[]>`
      SELECT version FROM content_entries WHERE id = ${entry.id}
    `;
    expect(unchanged?.version).toBe(entry.version);

    const acquireError: unknown = await acquireEditLock(deps, editorB, {
      entryId: entry.id,
    }).catch((caught: unknown) => caught);
    expect(acquireError).toBeInstanceOf(EntryLockedError);

    const nlEntryId = await insertSiblingLocaleRow(
      typeLockingId,
      entry.translationGroup,
      entry.publicId,
      'nl',
    );
    const nlSaved = await saveEntry(deps, editorB, {
      entryId: nlEntryId,
      baseVersion: 1,
      data: {},
    });
    expect(nlSaved.version).toBe(2);
  });

  it('heartbeat renewal: A renews at +100s, B is still refused at +200s, and B acquires at +220s once A stops renewing', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    const startTime = clock.now();

    await acquireEditLock(deps, editorA, { entryId: entry.id });

    clock.advance(100);
    const renewed = await renewEditLock(deps, editorA, {
      entryId: entry.id,
    });
    expect(renewed).toBe(true);

    clock.advance(100); // total elapsed since acquire: 200s; since renewal: 100s
    const stillBlocked: unknown = await acquireEditLock(deps, editorB, {
      entryId: entry.id,
    }).catch((caught: unknown) => caught);
    expect(stillBlocked).toBeInstanceOf(EntryLockedError);

    clock.advance(20); // total elapsed since renewal: 120s -- lapsed
    const grant = await acquireEditLock(deps, editorB, {
      entryId: entry.id,
    });
    expect(grant.lockedAt.getTime()).toBe(clock.now().getTime());
    expect(clock.now().getTime() - startTime.getTime()).toBe(220_000);
  });

  it("release: A releasing clears both lock columns; B releasing A's lock returns false and changes nothing", async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    await acquireEditLock(deps, editorA, { entryId: entry.id });

    const bReleased = await releaseEditLock(deps, editorB, {
      entryId: entry.id,
    });
    expect(bReleased).toBe(false);
    const [stillLocked] = await handle.sql<
      { lockedBy: string | null }[]
    >`SELECT locked_by AS "lockedBy" FROM content_entries WHERE id = ${entry.id}`;
    expect(stillLocked?.lockedBy).toBe(editorA.userId);

    const aReleased = await releaseEditLock(deps, editorA, {
      entryId: entry.id,
    });
    expect(aReleased).toBe(true);
    const [cleared] = await handle.sql<
      { lockedBy: string | null; lockedAt: Date | null }[]
    >`SELECT locked_by AS "lockedBy", locked_at AS "lockedAt" FROM content_entries WHERE id = ${entry.id}`;
    expect(cleared?.lockedBy).toBeNull();
    expect(cleared?.lockedAt).toBeNull();
  });

  it('takeover by a superset role (admin over editor): audited, version bumped, previous holder gets StaleVersionError', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    await acquireEditLock(deps, editorA, { entryId: entry.id });

    const takenOver = await takeOverEditLock(deps, admin, {
      entryId: entry.id,
    });
    expect(takenOver.version).toBe(entry.version + 1);

    const [lockRow] = await handle.sql<
      { lockedBy: string | null }[]
    >`SELECT locked_by AS "lockedBy" FROM content_entries WHERE id = ${entry.id}`;
    expect(lockRow?.lockedBy).toBe(admin.userId);

    const allowedRows = (await auditRowsFor('entry.lock-takeover')).filter(
      (row) => row.outcome === 'allowed',
    );
    expect(allowedRows.length).toBeGreaterThanOrEqual(1);

    const staleError: unknown = await saveEntry(deps, editorA, {
      entryId: entry.id,
      baseVersion: entry.version,
      data: {},
    }).catch((caught: unknown) => caught);
    expect(staleError).toBeInstanceOf(StaleVersionError);
  });

  it('takeover by an equal role (editor B over editor A): succeeds because equal permission sets qualify', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    await acquireEditLock(deps, editorA, { entryId: entry.id });

    const takenOver = await takeOverEditLock(deps, editorB, {
      entryId: entry.id,
    });
    expect(takenOver.version).toBe(entry.version + 1);

    const [lockRow] = await handle.sql<
      { lockedBy: string | null }[]
    >`SELECT locked_by AS "lockedBy" FROM content_entries WHERE id = ${entry.id}`;
    expect(lockRow?.lockedBy).toBe(editorB.userId);
  });

  it('takeover refused when the actor is not a permission superset of the holder: LockTakeoverForbiddenError, denied audit row, lock unchanged', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    await acquireEditLock(deps, editorA, { entryId: entry.id });

    const error: unknown = await takeOverEditLock(deps, author, {
      entryId: entry.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockTakeoverForbiddenError);

    const denied = (await auditRowsFor('entry.lock-takeover')).filter(
      (row) => row.outcome === 'denied',
    );
    expect(denied.length).toBeGreaterThanOrEqual(1);
    const lastDenied = denied.at(-1);
    expect(lastDenied?.after).toMatchObject({
      reason: 'not-permission-superset',
    });

    const [lockRow] = await handle.sql<
      { lockedBy: string | null }[]
    >`SELECT locked_by AS "lockedBy" FROM content_entries WHERE id = ${entry.id}`;
    expect(lockRow?.lockedBy).toBe(editorA.userId);
  });

  it('takeover refuses with LockStateChangedError when a holder that looked lapsed at pre-check time is live again by the time the takeover transaction reloads the row (WR-01)', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    await acquireEditLock(deps, editorA, { entryId: entry.id });
    clock.advance(EDIT_LOCK_TTL_SECONDS + 1); // lapsed from the pre-check's point of view

    const blocking = createDb({
      connectionString: testDatabase.connectionString,
      maxConnections: 1,
    });

    let resolveRenewSignal: () => void = () => {
      throw new Error('resolveRenewSignal called before it was assigned');
    };
    const renewSignal = new Promise<void>((resolve) => {
      resolveRenewSignal = resolve;
    });

    try {
      const blockingTxPromise = blocking.sql.begin(async (sql) => {
        await sql`SELECT id FROM content_entries WHERE id = ${entry.id} FOR UPDATE`;
        await renewSignal;
        await sql`
          UPDATE content_entries
          SET locked_at = ${clock.now().toISOString()}
          WHERE id = ${entry.id}
        `;
      });

      const takeoverPromise = takeOverEditLock(deps, author, {
        entryId: entry.id,
      }).catch((caught: unknown) => caught);

      const MAX_POLL_ATTEMPTS = 50;
      const POLL_INTERVAL_MS = 20;
      let waitingCount = 0;
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        const [row] = await handle.sql<{ count: string }[]>`
          SELECT count(*) AS count
          FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
        waitingCount = Number(row?.count ?? '0');
        if (waitingCount >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (waitingCount < 1) {
        throw new Error(
          'timed out waiting for the takeover to block on its FOR UPDATE reload',
        );
      }

      resolveRenewSignal();
      await blockingTxPromise;

      const takeoverResult: unknown = await takeoverPromise;
      expect(takeoverResult).toBeInstanceOf(LockStateChangedError);

      const [row] = await handle.sql<
        { lockedBy: string | null; version: number }[]
      >`SELECT locked_by AS "lockedBy", version FROM content_entries WHERE id = ${entry.id}`;
      expect(row?.lockedBy).toBe(editorA.userId);
      expect(row?.version).toBe(entry.version);

      const retryError: unknown = await takeOverEditLock(deps, author, {
        entryId: entry.id,
      }).catch((caught: unknown) => caught);
      expect(retryError).toBeInstanceOf(LockTakeoverForbiddenError);

      const denied = (await auditRowsFor('entry.lock-takeover')).filter(
        (auditRow) => auditRow.outcome === 'denied',
      );
      const lastDenied = denied.at(-1);
      expect(lastDenied?.after).toMatchObject({
        reason: 'not-permission-superset',
      });
    } finally {
      await blocking.close();
    }
  });

  it('a lapsed lock that nobody renews is still taken over by a non-superset actor (unchanged path)', async () => {
    const entry = await createEntry(deps, superadmin, {
      contentTypeKey: typeLockingKey,
      locale: 'en',
    });
    await acquireEditLock(deps, editorA, { entryId: entry.id });
    clock.advance(EDIT_LOCK_TTL_SECONDS + 1);

    const takenOver = await takeOverEditLock(deps, author, {
      entryId: entry.id,
    });
    expect(takenOver.lockedBy).toBe(author.userId);
  });
});
