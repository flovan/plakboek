import { randomUUID } from 'node:crypto';
import {
  createAuditRecorder,
  createUserWithRole,
  type AuditActor,
  type AuditRecorder,
} from '@plakboek/auth';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContentConfig, type ContentDeps } from '../../src/config.js';
import { createContentType } from '../../src/content-types.js';
import { createEntry } from '../../src/entries.js';
import { addField, deleteField } from '../../src/fields.js';
import { saveEntry, StaleVersionError } from '../../src/save.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * Lock ordering between the two families of write that touch both
 * `content_types` and `content_entries`.
 *
 * Schema operations (`fields.ts`, `content-types.ts`, `field-translatable.ts`)
 * lock the content type row first and then write entries. Entry writes
 * (`save.ts`, `publish.ts`, `lifecycle.ts`) used to do the opposite, which is
 * an ABBA cycle: a save holding entry rows waits for the type row while a
 * schema operation holding the type row waits for those entry rows. Postgres
 * breaks it by aborting one side with a deadlock error, which surfaces to a
 * user as a failed save.
 *
 * Both families now take the content type row first.
 */
describe('Lock ordering between entry writes and schema operations (C-WR-01)', () => {
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
    resolver = createPermissionResolver(defaultRoles);
    recorder = createAuditRecorder({ db: handle.db, resolver });
    deps = {
      db: handle.db,
      recorder,
      resolver,
      config: defineContentConfig({
        locales: ['en'],
        defaultLocale: 'en',
        timezone: 'Europe/Brussels',
      }),
    };
    async function makeUser(email: string, roleKey: string) {
      const created = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: email,
        roleKey,
      });
      return { userId: created.userId, roleKey: created.roleKey };
    }
    superadmin = await makeUser('lockorder-owner@example.com', 'superadmin');
    editor = await makeUser('lockorder-editor@example.com', 'editor');
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
    if (testDatabase !== undefined) await testDatabase.drop();
  });

  it('a concurrent save and schema operation serialize instead of deadlocking', async () => {
    const type = await createContentType(deps, superadmin, {
      key: 'lockOrderType',
      labelSingular: 'Lock order type',
      labelPlural: 'Lock order types',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'keep',
      label: 'Keep',
      fieldType: 'short_text',
    });
    await addField(deps, superadmin, {
      contentTypeKey: type.key,
      key: 'doomed',
      label: 'Doomed',
      fieldType: 'short_text',
    });
    const entry = await createEntry(deps, editor, {
      contentTypeKey: type.key,
      locale: 'en',
      data: { keep: 'a', doomed: 'b' },
    });

    // Hold the content type row so both callers below queue behind it. That
    // makes their relative order deterministic instead of a coin flip.
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
    let signalHeld: (xid: string) => void = () => {
      throw new Error('signalHeld called before it was assigned');
    };
    const held = new Promise<string>((resolve) => {
      signalHeld = resolve;
    });

    try {
      const blockingTx = blocking.sql.begin(async (sql) => {
        const [row] = await sql`
          SELECT pg_current_xact_id()::xid::text AS xid
          FROM content_types WHERE id = ${type.id} FOR UPDATE
        `;
        signalHeld(row?.xid ?? '');
        await blockerSignal;
      });

      const holderXid = await held;

      // Queue the schema operation for the type row FIRST, so that when the
      // blocker releases it wins the row. Order matters: if the save won the
      // row instead it would simply finish and release its entry locks, and
      // no cycle could form.
      const deletePromise = deleteField(deps, superadmin, {
        contentTypeKey: type.key,
        fieldKey: 'doomed',
      }).catch((caught: unknown) => caught);

      await waitForWaiters(holderXid, 1);

      // Now the save takes its entry locks (uncontended) and only then queues
      // for the type row behind the schema operation. Under the old ordering
      // that is the cycle: the save holds entries and wants the type, the
      // schema operation is about to hold the type and want those entries.
      const savePromise = saveEntry(deps, editor, {
        entryId: entry.id,
        baseVersion: entry.version,
        data: { keep: 'a2', doomed: 'b2' },
      }).catch((caught: unknown) => caught);

      await waitForWaiters(holderXid, 2);

      releaseBlocker();
      await blockingTx;

      const saveResult: unknown = await savePromise;
      const deleteResult: unknown = await deletePromise;

      // Before the reorder this pair deadlocked and Postgres aborted the save
      // with SQLSTATE 40P01 on its own `content_types ... FOR SHARE`. The two
      // must now serialize instead.
      const sqlStates = [saveResult, deleteResult].map((result) =>
        result instanceof Error
          ? ((result as { cause?: { code?: string } }).cause?.code ?? null)
          : null,
      );
      expect(sqlStates).toEqual([null, null]);

      // The schema operation wins the type row and runs to completion.
      expect(deleteResult).not.toBeInstanceOf(Error);

      // The save then finds its base version superseded, because deleting a
      // field rewrites every entry of the type and bumps their versions.
      // That is optimistic concurrency doing its job, and it is the outcome
      // the caller can retry. A deadlock is not.
      expect(saveResult).toBeInstanceOf(StaleVersionError);
    } finally {
      await blocking.sql.end({ timeout: 5 });
    }
  });

  /**
   * Counts callers queued behind the held content type row. Postgres shows
   * the first waiter as a `transactionid` wait on the holder's own xid, and
   * every later waiter as a `tuple` wait on the row instead, so counting only
   * the first form can never reach two.
   */
  async function waitForWaiters(xid: string, atLeast: number): Promise<void> {
    const deadline = Date.now() + 5000;
    let waiting = 0;
    while (waiting < atLeast && Date.now() < deadline) {
      const [row] = await handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_locks
        WHERE NOT granted
          AND (
            (locktype = 'transactionid' AND transactionid = ${xid}::xid)
            OR (locktype = 'tuple'
                AND relation = 'content_types'::regclass)
          )
      `;
      waiting = row?.count ?? 0;
    }
    expect(waiting).toBeGreaterThanOrEqual(atLeast);
  }
});
