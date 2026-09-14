import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
  type PermissionResolver,
} from '@plakboek/permissions';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditWriteError,
  PermissionDeniedError,
  createAuditRecorder,
  runAuditedMutation,
  type AuditActor,
  type AuditedMutation,
  type AuditFailureHook,
  type AuditWriteFailure,
} from '../../src/audit.js';
import {
  SUPERADMIN_ROLE_KEY,
  createUserWithRole,
} from '../../src/first-user.js';
import { user } from '../../src/schema.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const roles = defineRoles(defaultRoles);

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly resolver: PermissionResolver;
  readonly superadmin: AuditActor;
  readonly admin: AuditActor;
  readonly editor: AuditActor;
};

type StoredAuditRow = {
  readonly actorUserId: string | null;
  readonly actorRoleKey: string;
  readonly impersonatorUserId: string | null;
  readonly permission: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly outcome: string;
  readonly beforeIsNull: boolean;
  readonly afterIsNull: boolean;
  readonly before: unknown;
  readonly after: unknown;
};

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

async function createActor(
  handle: Db,
  name: string,
  roleKey: string,
): Promise<AuditActor> {
  const created = await createUserWithRole(handle.db, {
    id: randomUUID(),
    email: `${name.toLowerCase()}@example.com`,
    name,
    roleKey,
  });
  return { userId: created.userId, roleKey: created.roleKey };
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    await runMigrations({ connectionString: testDatabase.connectionString });
    const handle = createDb({
      connectionString: testDatabase.connectionString,
    });
    current = {
      testDatabase,
      handle,
      resolver: createPermissionResolver(roles),
      superadmin: await createActor(handle, 'Owner', SUPERADMIN_ROLE_KEY),
      admin: await createActor(handle, 'Admin', 'admin'),
      editor: await createActor(handle, 'Editor', 'editor'),
    };
  } catch (error) {
    await testDatabase.drop();
    throw error;
  }
});

afterEach(async () => {
  const finished = current;
  current = undefined;
  vi.restoreAllMocks();
  if (finished !== undefined) {
    await finished.handle.close();
    await finished.testDatabase.drop();
  }
});

async function auditRows(): Promise<StoredAuditRow[]> {
  const rows = await fixture().handle.sql<StoredAuditRow[]>`
    SELECT actor_user_id AS "actorUserId", actor_role_key AS "actorRoleKey",
           impersonator_user_id AS "impersonatorUserId", permission, action,
           entity_type AS "entityType", entity_id AS "entityId", outcome,
           before IS NULL AS "beforeIsNull", after IS NULL AS "afterIsNull",
           before, after
    FROM audit_log ORDER BY id
  `;
  return [...rows];
}

async function nameOf(userId: string): Promise<string | undefined> {
  const [row] = await fixture().handle.sql<{ name: string }[]>`
    SELECT name FROM "user" WHERE id = ${userId}
  `;
  return row?.name;
}

function renameMutation(userId: string, name: string): AuditedMutation<string> {
  return async (tx) => {
    await tx.update(user).set({ name }).where(eq(user.id, userId));
    return { result: userId, after: { name } };
  };
}

describe('audited mutations (USER-08, D-05, D-06)', () => {
  it('records a granted mutation with its actor, permission, entity and after state', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });

    const result = await recorder.run(
      superadmin,
      {
        permission: 'users:edit',
        action: 'user.update',
        entityType: 'user',
        entityId: editor.userId,
        before: { name: 'Editor' },
      },
      renameMutation(editor.userId, 'Edited Editor'),
    );

    expect(result).toBe(editor.userId);
    expect(await nameOf(editor.userId)).toBe('Edited Editor');
    expect(await auditRows()).toEqual([
      {
        actorUserId: superadmin.userId,
        actorRoleKey: SUPERADMIN_ROLE_KEY,
        impersonatorUserId: null,
        permission: 'users:edit',
        action: 'user.update',
        entityType: 'user',
        entityId: editor.userId,
        outcome: 'allowed',
        beforeIsNull: false,
        afterIsNull: false,
        before: { name: 'Editor' },
        after: { name: 'Edited Editor' },
      },
    ]);
  });

  it('records the impersonating superadmin next to the acting user (D-11)', async () => {
    const { handle, resolver, superadmin, admin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });

    await recorder.run(
      { ...admin, impersonatedBy: superadmin.userId },
      {
        permission: 'users:edit',
        action: 'user.update',
        entityType: 'user',
        entityId: editor.userId,
      },
      renameMutation(editor.userId, 'Renamed While Impersonating'),
    );

    const [row] = await auditRows();
    expect(row?.actorUserId).toBe(admin.userId);
    expect(row?.actorRoleKey).toBe('admin');
    expect(row?.impersonatorUserId).toBe(superadmin.userId);
  });

  it('leaves the entity untouched when permission is denied and records the refusal', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });
    let mutationRan = false;

    const error: unknown = await recorder
      .run(
        editor,
        {
          permission: 'users:edit',
          action: 'user.update',
          entityType: 'user',
          entityId: superadmin.userId,
          before: { name: 'Owner' },
          after: { name: 'Hijacked' },
        },
        async (tx) => {
          mutationRan = true;
          return await renameMutation(superadmin.userId, 'Hijacked')(tx);
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error).toMatchObject({
      permission: 'users:edit',
      roleKey: 'editor',
    });
    expect(String(error)).not.toContain(editor.userId);
    expect(mutationRan).toBe(false);
    expect(await nameOf(superadmin.userId)).toBe('Owner');

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: editor.userId,
      actorRoleKey: 'editor',
      permission: 'users:edit',
      entityId: superadmin.userId,
      outcome: 'denied',
      beforeIsNull: true,
      afterIsNull: true,
    });
  });

  it('writes two distinct rows for two mutations by one actor in one request', async () => {
    const { handle, resolver, superadmin, admin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });

    await recorder.run(
      superadmin,
      {
        permission: 'users:edit',
        action: 'user.update',
        entityType: 'user',
        entityId: editor.userId,
        before: { name: 'Editor' },
      },
      renameMutation(editor.userId, 'Editor Two'),
    );
    await recorder.run(
      superadmin,
      {
        permission: 'users:edit',
        action: 'user.update',
        entityType: 'user',
        entityId: admin.userId,
        before: { name: 'Admin' },
      },
      renameMutation(admin.userId, 'Admin Two'),
    );

    const rows = await auditRows();
    expect(
      rows.map(({ actorUserId, entityId, before, after }) => ({
        actorUserId,
        entityId,
        before,
        after,
      })),
    ).toEqual([
      {
        actorUserId: superadmin.userId,
        entityId: editor.userId,
        before: { name: 'Editor' },
        after: { name: 'Editor Two' },
      },
      {
        actorUserId: superadmin.userId,
        entityId: admin.userId,
        before: { name: 'Admin' },
        after: { name: 'Admin Two' },
      },
    ]);
  });

  it('stores a creation with before as SQL NULL and after as the created state', async () => {
    const { handle, resolver, superadmin } = fixture();
    const newUserId = randomUUID();

    await runAuditedMutation(
      { db: handle.db, resolver },
      superadmin,
      {
        permission: 'users:create',
        action: 'user.create',
        entityType: 'user',
        entityId: newUserId,
      },
      async (tx) => {
        const created = await createUserWithRole(tx, {
          id: newUserId,
          email: 'new@example.com',
          name: 'New',
          roleKey: 'editor',
        });
        return {
          result: created,
          after: { id: created.userId, name: 'New', roleKey: created.roleKey },
        };
      },
    );

    const [row] = await handle.sql<
      { beforeIsNull: boolean; afterType: string | null }[]
    >`
      SELECT before IS NULL AS "beforeIsNull", jsonb_typeof(after) AS "afterType"
      FROM audit_log WHERE entity_id = ${newUserId}
    `;
    expect(row).toEqual({ beforeIsNull: true, afterType: 'object' });
    const [emptyObjects] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE before = '{}'::jsonb OR before = 'null'::jsonb
    `;
    expect(emptyObjects?.count).toBe(0);
  });

  it('stores a deletion with a non-null before and after as SQL NULL', async () => {
    const { handle, resolver, superadmin, admin } = fixture();

    await runAuditedMutation(
      { db: handle.db, resolver },
      superadmin,
      {
        permission: 'users:deactivate',
        action: 'user.delete',
        entityType: 'user',
        entityId: admin.userId,
        before: { id: admin.userId, name: 'Admin', roleKey: 'admin' },
      },
      async (tx) => {
        await tx.delete(user).where(eq(user.id, admin.userId));
        return { result: undefined };
      },
    );

    expect(await nameOf(admin.userId)).toBeUndefined();
    const [row] = await handle.sql<
      { beforeIsNull: boolean; afterIsNull: boolean }[]
    >`
      SELECT before IS NULL AS "beforeIsNull", after IS NULL AS "afterIsNull"
      FROM audit_log WHERE entity_id = ${admin.userId}
    `;
    expect(row).toEqual({ beforeIsNull: false, afterIsNull: true });
  });

  it('reads a burst inside one transaction back in write order by id, with identical created_at', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const fixedInstant = new Date('2026-09-14T12:00:00.000Z');

    await handle.db.transaction(async (tx) => {
      for (const name of ['first', 'second', 'third']) {
        await runAuditedMutation(
          { db: tx, resolver, now: () => fixedInstant },
          superadmin,
          {
            permission: 'users:edit',
            action: 'user.update',
            entityType: 'user',
            entityId: editor.userId,
          },
          renameMutation(editor.userId, name),
        );
      }
    });

    const oldestFirst = await handle.sql<{ name: string }[]>`
      SELECT after ->> 'name' AS name FROM audit_log ORDER BY id
    `;
    const newestFirst = await handle.sql<{ name: string }[]>`
      SELECT after ->> 'name' AS name FROM audit_log ORDER BY id DESC
    `;
    expect(oldestFirst.map((row) => row.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(newestFirst.map((row) => row.name)).toEqual([
      'third',
      'second',
      'first',
    ]);

    const [instants] = await handle.sql<{ distinct: number }[]>`
      SELECT count(DISTINCT created_at)::int AS "distinct" FROM audit_log
    `;
    expect(instants?.distinct).toBe(1);
  });

  it('stores the redaction marker, never the value, for a password field', async () => {
    const { handle, resolver, superadmin } = fixture();
    const newUserId = randomUUID();
    const plainPassword = 'plain-text-password-never-stored';

    await runAuditedMutation(
      { db: handle.db, resolver },
      superadmin,
      {
        permission: 'users:create',
        action: 'user.create',
        entityType: 'user',
        entityId: newUserId,
        before: { session: { sessionToken: 'session-token-never-stored' } },
      },
      async (tx) => {
        const created = await createUserWithRole(tx, {
          id: newUserId,
          email: 'redacted@example.com',
          name: 'Redacted',
          roleKey: 'editor',
        });
        return {
          result: created,
          after: {
            id: created.userId,
            email: 'redacted@example.com',
            password: plainPassword,
          },
        };
      },
    );

    const [row] = await handle.sql<
      {
        password: string | null;
        email: string | null;
        sessionToken: string | null;
        stored: string;
      }[]
    >`
      SELECT after ->> 'password' AS password, after ->> 'email' AS email,
             before -> 'session' ->> 'sessionToken' AS "sessionToken",
             before::text || after::text AS stored
      FROM audit_log WHERE entity_id = ${newUserId}
    `;
    expect(row?.password).toBe('[redacted]');
    expect(row?.sessionToken).toBe('[redacted]');
    expect(row?.email).toBe('redacted@example.com');
    expect(row?.stored).not.toContain(plainPassword);
    expect(row?.stored).not.toContain('session-token-never-stored');
  });
});

describe('a failed audit write (T-02-24, T-02-29)', () => {
  const failureCases = [
    {
      label: 'the database rejects the row (actor with no user row)',
      actor: (): AuditActor => ({
        userId: randomUUID(),
        roleKey: SUPERADMIN_ROLE_KEY,
      }),
      after: (): unknown => ({ name: 'Never Committed' }),
    },
    {
      label: 'the payload cannot be serialised',
      actor: (): AuditActor => fixture().superadmin,
      after: (): unknown => ({ name: 'Never Committed', size: 1n }),
    },
  ];

  it.each(failureCases)(
    'rolls the mutation back, throws AuditWriteError and calls the hook once when $label',
    async ({ actor, after }) => {
      const { handle, resolver, editor } = fixture();
      const failures: AuditWriteFailure[] = [];
      const recorder = createAuditRecorder({
        db: handle.db,
        resolver,
        onAuditWriteFailed: (failure) => {
          failures.push(failure);
        },
      });
      const acting = actor();

      const error: unknown = await recorder
        .run(
          acting,
          {
            permission: 'users:edit',
            action: 'user.update',
            entityType: 'user',
            entityId: editor.userId,
          },
          async (tx) => {
            await tx
              .update(user)
              .set({ name: 'Never Committed' })
              .where(eq(user.id, editor.userId));
            return { result: undefined, after: after() };
          },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AuditWriteError);
      expect((error as AuditWriteError).cause).toBeDefined();
      expect(await nameOf(editor.userId)).toBe('Editor');
      expect(await auditRows()).toEqual([]);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        permission: 'users:edit',
        action: 'user.update',
        entityType: 'user',
        entityId: editor.userId,
        actorUserId: acting.userId,
      });
      expect(failures[0]?.error).toBe(error);
      expect(failures[0]?.occurredAt).toBeInstanceOf(Date);
    },
  );

  it('keeps the outcome when the hook throws or rejects, and the hook error never escapes', async () => {
    const { handle, resolver, editor } = fixture();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const failingActor: AuditActor = {
      userId: randomUUID(),
      roleKey: SUPERADMIN_ROLE_KEY,
    };
    const entry = {
      permission: 'users:edit',
      action: 'user.update',
      entityType: 'user',
      entityId: editor.userId,
    } as const;

    const throwingHook = vi.fn<AuditFailureHook>(() => {
      throw new Error('broken hook');
    });
    const throwing = await createAuditRecorder({
      db: handle.db,
      resolver,
      onAuditWriteFailed: throwingHook,
    })
      .run(failingActor, entry, renameMutation(editor.userId, 'Never'))
      .catch((caught: unknown) => caught);

    expect(throwing).toBeInstanceOf(AuditWriteError);
    expect(throwingHook).toHaveBeenCalledTimes(1);
    expect(await nameOf(editor.userId)).toBe('Editor');

    // An async host hook, or one written in plain JS, can hand back a
    // rejected promise even though the contract says void.
    const rejectingHook = vi.fn<AuditFailureHook>(
      () => Promise.reject(new Error('async hook')) as unknown as undefined,
    );
    const rejecting = await createAuditRecorder({
      db: handle.db,
      resolver,
      onAuditWriteFailed: rejectingHook,
    })
      .run(failingActor, entry, renameMutation(editor.userId, 'Never'))
      .catch((caught: unknown) => caught);
    await new Promise((resolve) => setImmediate(resolve));

    expect(rejecting).toBeInstanceOf(AuditWriteError);
    expect(rejectingHook).toHaveBeenCalledTimes(1);
    expect(await nameOf(editor.userId)).toBe('Editor');
    expect(await auditRows()).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('logs one line by default that names the action but not the payload', async () => {
    const { handle, resolver, editor } = fixture();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      createAuditRecorder({ db: handle.db, resolver }).run(
        { userId: randomUUID(), roleKey: SUPERADMIN_ROLE_KEY },
        {
          permission: 'users:edit',
          action: 'user.update',
          entityType: 'user',
          entityId: editor.userId,
        },
        renameMutation(editor.userId, 'Secret Payload Name'),
      ),
    ).rejects.toBeInstanceOf(AuditWriteError);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0]?.map(String).join(' ') ?? '';
    expect(logged).toContain('user.update');
    expect(logged).toContain('users:edit');
    expect(logged).not.toContain('Secret Payload Name');
  });
});
