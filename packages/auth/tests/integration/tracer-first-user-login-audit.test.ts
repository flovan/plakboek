import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  ALL_PERMISSIONS,
  createPermissionResolver,
  defaultRoles,
  defineRoles,
} from '@plakboek/permissions';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  AuditWriteError,
  PermissionDeniedError,
  SUPERADMIN_ROLE_KEY,
  createAuth,
  createUserWithRole,
  runAuditedMutation,
  type MailMessage,
  type MailSender,
} from '../../src/index.js';
import * as schema from '../../src/schema.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'tracer-test-secret-with-at-least-32-characters';
const PASSWORD = 'correct horse battery staple';
const SESSION_COOKIE_PATTERN = /better-auth\.session_token=([^;]+)/;

const roles = defineRoles(defaultRoles);

function recordingMailSender(): MailSender & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

type ColumnShape = {
  readonly table: string;
  readonly column: string;
  readonly type: string;
  readonly notNull: boolean;
};

/** Drizzle reports a serial column by its pseudo-type; the catalogue reports
 * the storage type it expands to. */
function catalogueType(sqlType: string): string {
  return sqlType === 'bigserial' ? 'bigint' : sqlType;
}

function byText(a: string, b: string): number {
  return a.localeCompare(b);
}

function sortShapes<
  T extends { readonly table: string; readonly column: string },
>(shapes: T[]): T[] {
  return shapes.toSorted((a, b) =>
    byText(`${a.table}.${a.column}`, `${b.table}.${b.column}`),
  );
}

/**
 * Proves the hand-written SQL in `0001_auth_core` and the Drizzle schema
 * describe the same tables: every column's type and nullability, every
 * named index, and every foreign key's delete rule.
 */
async function expectMigrationMatchesSchema(db: Db): Promise<void> {
  const tables: PgTable[] = Object.values(schema);
  const configs = tables.map((table) => getTableConfig(table));
  const tableNames = configs.map((config) => config.name);

  const expectedColumns = sortShapes(
    configs.flatMap((config) =>
      config.columns.map((column) => ({
        table: config.name,
        column: column.name,
        type: catalogueType(column.getSQLType()),
        notNull: column.notNull,
      })),
    ),
  );
  const actualColumns = await db.sql<ColumnShape[]>`
    SELECT c.relname AS "table", a.attname AS "column",
           format_type(a.atttypid, a.atttypmod) AS "type",
           a.attnotnull AS "notNull"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname = ANY(${tableNames})
  `;
  expect(sortShapes([...actualColumns])).toEqual(expectedColumns);

  const expectedIndexes = configs
    .flatMap((config) =>
      config.indexes.map((index) => index.config.name ?? '(unnamed index)'),
    )
    .toSorted(byText);
  const actualIndexes = await db.sql<{ name: string }[]>`
    SELECT indexname AS "name" FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ANY(${tableNames})
      AND indexname LIKE '%\\_idx'
  `;
  expect(actualIndexes.map((row) => row.name).toSorted(byText)).toEqual(
    expectedIndexes,
  );

  const deleteRules: Record<string, string> = {
    a: 'no action',
    c: 'cascade',
    n: 'set null',
  };
  const expectedForeignKeys = sortShapes(
    configs.flatMap((config) =>
      config.foreignKeys.map((foreignKey) => ({
        table: config.name,
        column: foreignKey
          .reference()
          .columns.map((c) => c.name)
          .join(','),
        onDelete: foreignKey.onDelete ?? 'no action',
      })),
    ),
  );
  const actualForeignKeys = await db.sql<
    { table: string; column: string; code: string }[]
  >`
    SELECT c.relname AS "table", a.attname AS "column",
           con.confdeltype AS "code"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_attribute a ON a.attrelid = con.conrelid
      AND a.attnum = ANY(con.conkey)
    WHERE con.contype = 'f' AND c.relname = ANY(${tableNames})
  `;
  expect(
    sortShapes(
      actualForeignKeys.map((row) => ({
        table: row.table,
        column: row.column,
        onDelete: deleteRules[row.code] ?? row.code,
      })),
    ),
  ).toEqual(expectedForeignKeys);
}

describe('tracer: first user bootstraps, signs in, and performs one audited mutation', () => {
  it('runs the whole path against a real Postgres', async () => {
    const testDatabase = await createTestDatabase();
    const handles: Db[] = [];
    try {
      // Layer 1: the migration creates exactly the schema Drizzle describes,
      // and a second run applies nothing.
      const firstRun = await runMigrations({
        connectionString: testDatabase.connectionString,
      });
      expect(firstRun.applied).toEqual(['0001_auth_core']);
      const secondRun = await runMigrations({
        connectionString: testDatabase.connectionString,
      });
      expect(secondRun.applied).toEqual([]);
      expect(secondRun.alreadyApplied).toContain('0001_auth_core');

      const handle = createDb({
        connectionString: testDatabase.connectionString,
      });
      handles.push(handle);
      await expectMigrationMatchesSchema(handle);

      // Layer 2: better-auth wired to the drizzle adapter.
      const mail = recordingMailSender();
      const auth = createAuth({
        db: handle.db,
        baseURL: BASE_URL,
        secret: SECRET,
        mail,
        roles,
      });

      // Layer 3: the first user is forced to superadmin (AUTH-01, D-14).
      const email = 'owner@example.com';
      const first = await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: 'Owner',
        roleKey: 'editor',
      });
      expect(first.wasFirstUser).toBe(true);
      expect(first.roleKey).toBe(SUPERADMIN_ROLE_KEY);
      const [storedFirst] = await handle.sql<{ roleKey: string }[]>`
        SELECT role_key AS "roleKey" FROM "user" WHERE id = ${first.userId}
      `;
      expect(storedFirst?.roleKey).toBe(SUPERADMIN_ROLE_KEY);
      const resolver = createPermissionResolver(roles);
      expect(resolver.resolve(SUPERADMIN_ROLE_KEY).size).toBe(
        ALL_PERMISSIONS.length,
      );

      // Layer 4: a password set through better-auth's server context, then a
      // real email-and-password sign-in.
      const context = await auth.$context;
      await context.internalAdapter.linkAccount({
        userId: first.userId,
        providerId: 'credential',
        accountId: first.userId,
        password: await context.password.hash(PASSWORD),
      });
      const signIn = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
      });
      expect(signIn.response.user.id).toBe(first.userId);
      const sessionCookie = SESSION_COOKIE_PATTERN.exec(
        signIn.headers.get('set-cookie') ?? '',
      )?.[1];
      expect(sessionCookie).toBeDefined();

      // Layer 5: the session survives a refresh (AUTH-10) -- a separate
      // connection pool and a separate better-auth instance, holding nothing
      // but the cookie, resolve the same user from Postgres.
      const refreshHandle = createDb({
        connectionString: testDatabase.connectionString,
      });
      handles.push(refreshHandle);
      const refreshedAuth = createAuth({
        db: refreshHandle.db,
        baseURL: BASE_URL,
        secret: SECRET,
        mail: recordingMailSender(),
        roles,
      });
      const refetched = await refreshedAuth.api.getSession({
        headers: new Headers({
          cookie: `better-auth.session_token=${sessionCookie ?? ''}`,
        }),
      });
      expect(refetched?.user.id).toBe(first.userId);
      expect(refetched?.session.token).toBe(signIn.response.token);

      // Layer 6: one permission-gated mutation writes its audit row in the
      // same transaction (USER-08, D-05, D-06).
      const deps = { db: handle.db, resolver };
      const secondUserId = randomUUID();
      const created = await runAuditedMutation(
        deps,
        { userId: first.userId, roleKey: first.roleKey },
        {
          permission: 'users:create',
          action: 'user.create',
          entityType: 'user',
          entityId: secondUserId,
        },
        async (tx) => {
          const result = await createUserWithRole(tx, {
            id: secondUserId,
            email: 'editor@example.com',
            name: 'Editor',
            roleKey: 'editor',
          });
          return {
            result,
            after: {
              id: result.userId,
              email: 'editor@example.com',
              name: 'Editor',
              roleKey: result.roleKey,
            },
          };
        },
      );
      expect(created).toEqual({
        userId: secondUserId,
        roleKey: 'editor',
        wasFirstUser: false,
      });

      const auditRows = await handle.sql<
        {
          outcome: string;
          actorUserId: string | null;
          actorRoleKey: string;
          permission: string;
          entityId: string | null;
          beforeIsNull: boolean;
          afterType: string | null;
          afterRoleKey: string | null;
        }[]
      >`
        SELECT outcome, actor_user_id AS "actorUserId",
               actor_role_key AS "actorRoleKey", permission,
               entity_id AS "entityId", before IS NULL AS "beforeIsNull",
               jsonb_typeof(after) AS "afterType",
               after ->> 'roleKey' AS "afterRoleKey"
        FROM audit_log ORDER BY id
      `;
      expect(auditRows).toEqual([
        {
          outcome: 'allowed',
          actorUserId: first.userId,
          actorRoleKey: SUPERADMIN_ROLE_KEY,
          permission: 'users:create',
          entityId: secondUserId,
          beforeIsNull: true,
          afterType: 'object',
          afterRoleKey: 'editor',
        },
      ]);

      // The audit row and its mutation commit or roll back together: an
      // audit insert that fails (here, an actor id with no user row) leaves
      // the user it would have described uncreated.
      const rolledBackUserId = randomUUID();
      await expect(
        runAuditedMutation(
          deps,
          { userId: randomUUID(), roleKey: SUPERADMIN_ROLE_KEY },
          {
            permission: 'users:create',
            action: 'user.create',
            entityType: 'user',
            entityId: rolledBackUserId,
          },
          async (tx) => ({
            result: await createUserWithRole(tx, {
              id: rolledBackUserId,
              email: 'rolled-back@example.com',
              name: 'Rolled Back',
              roleKey: 'editor',
            }),
          }),
        ),
      ).rejects.toBeInstanceOf(AuditWriteError);
      const [rolledBack] = await handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM "user" WHERE id = ${rolledBackUserId}
      `;
      expect(rolledBack?.count).toBe(0);

      // A refusal is recorded and the mutation never runs.
      let deniedMutationRan = false;
      await expect(
        runAuditedMutation(
          deps,
          { userId: created.userId, roleKey: created.roleKey },
          {
            permission: 'users:create',
            action: 'user.create',
            entityType: 'user',
          },
          () => {
            deniedMutationRan = true;
            return Promise.resolve({ result: undefined });
          },
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(deniedMutationRan).toBe(false);
      const outcomes = await handle.sql<
        { outcome: string; actorUserId: string | null }[]
      >`
        SELECT outcome, actor_user_id AS "actorUserId"
        FROM audit_log ORDER BY id
      `;
      expect(outcomes).toEqual([
        { outcome: 'allowed', actorUserId: first.userId },
        { outcome: 'denied', actorUserId: created.userId },
      ]);

      expect(mail.sent).toEqual([]);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      await testDatabase.drop();
    }
  });

  it('grants superadmin to exactly one of two concurrent first-user creations', async () => {
    const testDatabase: TestDatabase = await createTestDatabase();
    const handles: Db[] = [];
    try {
      // Two overlapping migrators apply 0001_auth_core exactly once.
      const runs = await Promise.all([
        runMigrations({ connectionString: testDatabase.connectionString }),
        runMigrations({ connectionString: testDatabase.connectionString }),
      ]);
      expect(runs.flatMap((run) => run.applied)).toEqual(['0001_auth_core']);

      const handle = createDb({
        connectionString: testDatabase.connectionString,
      });
      handles.push(handle);

      const requests = [
        { id: randomUUID(), email: 'a@example.com', roleKey: 'editor' },
        { id: randomUUID(), email: 'b@example.com', roleKey: 'admin' },
      ];
      const results = await Promise.all(
        requests.map((request) =>
          createUserWithRole(handle.db, { ...request, name: request.email }),
        ),
      );

      const [superadmins] = await handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM "user"
        WHERE role_key = ${SUPERADMIN_ROLE_KEY}
      `;
      expect(superadmins?.count).toBe(1);
      expect(results.filter((result) => result.wasFirstUser)).toHaveLength(1);

      const loserIndex = results.findIndex((result) => !result.wasFirstUser);
      expect(results[loserIndex]?.roleKey).toBe(requests[loserIndex]?.roleKey);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      await testDatabase.drop();
    }
  });
});
