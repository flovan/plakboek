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
  AfterCommitRegistrationError,
  AuditWriteError,
  PermissionDeniedError,
  createAuditRecorder,
  type AfterCommitFailure,
  type AuditActor,
  type AuditEntryInput,
  type AuditMutationContext,
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
  readonly editor: AuditActor;
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

async function nameOf(userId: string): Promise<string | undefined> {
  const [row] = await fixture().handle.sql<{ name: string }[]>`
    SELECT name FROM "user" WHERE id = ${userId}
  `;
  return row?.name;
}

async function auditRowCount(): Promise<number> {
  const [row] = await fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_log
  `;
  return row?.count ?? -1;
}

function renameEntry(userId: string): AuditEntryInput {
  return {
    permission: 'users:edit',
    action: 'user.update',
    entityType: 'user',
    entityId: userId,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('after-commit callbacks (D-18, PUB-11)', () => {
  it('runs callbacks after the commit, in registration order, with the committed row visible elsewhere', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });
    const observer = createDb({
      connectionString: fixture().testDatabase.connectionString,
    });
    const order: string[] = [];
    const seenFromOtherConnection: (string | undefined)[] = [];

    try {
      const result = await recorder.run(
        superadmin,
        renameEntry(editor.userId),
        async (tx, context) => {
          await tx
            .update(user)
            .set({ name: 'Committed Name' })
            .where(eq(user.id, editor.userId));
          context.afterCommit(async () => {
            order.push('A');
            const [row] = await observer.sql<{ name: string }[]>`
              SELECT name FROM "user" WHERE id = ${editor.userId}
            `;
            seenFromOtherConnection.push(row?.name);
          });
          context.afterCommit(() => {
            order.push('B');
          });
          return { result: 'done', after: { name: 'Committed Name' } };
        },
      );

      expect(result).toBe('done');
      expect(order).toEqual(['A', 'B']);
      expect(seenFromOtherConnection).toEqual(['Committed Name']);
    } finally {
      await observer.close();
    }
  });

  it('awaits every callback before run resolves', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });
    let finished = false;

    const startedAt = Date.now();
    await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (_tx, context) => {
        context.afterCommit(async () => {
          await sleep(50);
          finished = true;
        });
        return { result: undefined };
      },
    );

    expect(finished).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
  });

  it('runs no callback for a denied actor and throws PermissionDeniedError', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });
    let ran = false;
    let mutationRan = false;

    const error: unknown = await recorder
      .run(editor, renameEntry(superadmin.userId), async (_tx, context) => {
        mutationRan = true;
        context.afterCommit(() => {
          ran = true;
        });
        return { result: undefined };
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(mutationRan).toBe(false);
    expect(ran).toBe(false);
    expect(await auditRowCount()).toBe(1);
  });

  it('runs no callback when the mutation throws, and commits nothing', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });
    const boom = new Error('mutation failed');
    let ran = false;

    const error: unknown = await recorder
      .run(superadmin, renameEntry(editor.userId), async (tx, context) => {
        await tx
          .update(user)
          .set({ name: 'Never Committed' })
          .where(eq(user.id, editor.userId));
        context.afterCommit(() => {
          ran = true;
        });
        throw boom;
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(boom);
    expect(ran).toBe(false);
    expect(await nameOf(editor.userId)).toBe('Editor');
    expect(await auditRowCount()).toBe(0);
  });

  it('runs no callback when the audit insert fails, and throws AuditWriteError', async () => {
    const { handle, resolver, editor } = fixture();
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver,
      onAuditWriteFailed: () => undefined,
    });
    const actorWithoutUserRow: AuditActor = {
      userId: randomUUID(),
      roleKey: SUPERADMIN_ROLE_KEY,
    };
    let ran = false;

    const error: unknown = await recorder
      .run(
        actorWithoutUserRow,
        renameEntry(editor.userId),
        async (tx, context) => {
          await tx
            .update(user)
            .set({ name: 'Never Committed' })
            .where(eq(user.id, editor.userId));
          context.afterCommit(() => {
            ran = true;
          });
          return { result: undefined };
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuditWriteError);
    expect(ran).toBe(false);
    expect(await nameOf(editor.userId)).toBe('Editor');
  });

  it('isolates a throwing callback: run resolves, later callbacks run, the hook reports once', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const failures: AfterCommitFailure[] = [];
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver,
      onAfterCommitFailed: (failure) => {
        failures.push(failure);
      },
    });
    const purgeError = new Error('purge failed');
    let secondRan = false;

    const result = await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (tx, context) => {
        await tx
          .update(user)
          .set({ name: 'Kept' })
          .where(eq(user.id, editor.userId));
        context.afterCommit(() => {
          throw purgeError;
        });
        context.afterCommit(() => {
          secondRan = true;
        });
        return { result: 'still-resolved' };
      },
    );

    expect(result).toBe('still-resolved');
    expect(secondRan).toBe(true);
    expect(await nameOf(editor.userId)).toBe('Kept');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      permission: 'users:edit',
      action: 'user.update',
      entityType: 'user',
      entityId: editor.userId,
      actorUserId: superadmin.userId,
      error: purgeError,
    });
    expect(failures[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it('isolates a rejecting callback the same way', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const failures: AfterCommitFailure[] = [];
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver,
      onAfterCommitFailed: (failure) => {
        failures.push(failure);
      },
    });

    const result = await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (_tx, context) => {
        context.afterCommit(() => Promise.reject(new Error('async purge')));
        return { result: 7 };
      },
    );

    expect(result).toBe(7);
    expect(failures).toHaveLength(1);
  });

  it('lets run resolve when the failure hook itself throws', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver,
      onAfterCommitFailed: () => {
        throw new Error('hook broke');
      },
    });

    const result = await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (_tx, context) => {
        context.afterCommit(() => {
          throw new Error('purge failed');
        });
        return { result: 'ok' };
      },
    );

    expect(result).toBe('ok');
    expect(consoleError).toHaveBeenCalled();
  });

  it('logs one redacted line by default, never the error message', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const recorder = createAuditRecorder({ db: handle.db, resolver });

    await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (_tx, context) => {
        context.afterCommit(() => {
          throw new TypeError('secret-parameter-value');
        });
        return { result: undefined };
      },
    );

    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0]?.[0]);
    expect(line).toContain('user.update');
    expect(line).toContain('user');
    expect(line).toContain('TypeError');
    expect(line).not.toContain('secret-parameter-value');
  });

  it('refuses afterCommit on a recorder bound to a transaction', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    let refusal: unknown;

    await handle.db.transaction(async (outer) => {
      const nested = createAuditRecorder({ db: outer, resolver });
      await nested.run(
        superadmin,
        renameEntry(editor.userId),
        async (_tx, context) => {
          try {
            context.afterCommit(() => undefined);
          } catch (error) {
            refusal = error;
          }
          return { result: undefined };
        },
      );
    });

    expect(refusal).toBeInstanceOf(AfterCommitRegistrationError);
    expect(refusal).toMatchObject({ reason: 'nested-transaction' });
  });

  it('refuses a captured afterCommit once the mutation has returned', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });
    let captured: AuditMutationContext | undefined;

    await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (_tx, context) => {
        captured = context;
        return { result: undefined };
      },
    );

    expect(captured).toBeDefined();
    let refusal: unknown;
    try {
      captured?.afterCommit(() => undefined);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AfterCommitRegistrationError);
    expect(refusal).toMatchObject({ reason: 'closed' });
  });

  it('keeps a one-argument mutation working unchanged', async () => {
    const { handle, resolver, superadmin, editor } = fixture();
    const recorder = createAuditRecorder({ db: handle.db, resolver });

    const result = await recorder.run(
      superadmin,
      renameEntry(editor.userId),
      async (tx) => {
        await tx
          .update(user)
          .set({ name: 'Plain' })
          .where(eq(user.id, editor.userId));
        return { result: 'plain', after: { name: 'Plain' } };
      },
    );

    expect(result).toBe('plain');
    expect(await nameOf(editor.userId)).toBe('Plain');
    expect(await auditRowCount()).toBe(1);
  });
});
