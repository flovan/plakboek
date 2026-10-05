/**
 * bootstrapInstallation against real Postgres: the first superadmin, the
 * published seed, the first-user race, refusal on a non-empty installation,
 * an unready database, and the password working through better-auth.
 */
import { runMigrations } from '@plakboek/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BootstrapValidationError,
  DatabaseNotReadyError,
  InstallationNotEmptyError,
  bootstrapInstallation,
} from '../../src/runtime/bootstrap.js';
import { closeAllDbs } from '../../src/runtime/db.js';
import { readRuntimeEnv } from '../../src/runtime/env.js';
import { createRuntime, type Runtime } from '../../src/runtime/runtime.js';
import type { HostModule, PlakboekConfig } from '../../src/types.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const PASSWORD = 'correct horse battery staple';

describe('bootstrapInstallation', () => {
  let config: PlakboekConfig;
  const databases: TestDatabase[] = [];

  beforeAll(async () => {
    ({ default: config } = await import('../fixture-host/plakboek.config.ts'));
  });

  afterEach(async () => {
    await closeAllDbs();
    for (const database of databases.splice(0)) await database.drop();
  });

  async function freshInstallation(
    options: { migrate?: boolean; host?: HostModule } = {},
  ): Promise<{ runtime: Runtime; database: TestDatabase }> {
    const database = await createTestDatabase();
    databases.push(database);
    if (options.migrate !== false) {
      await runMigrations({ connectionString: database.connectionString });
    }
    const env = readRuntimeEnv({
      DATABASE_URL: database.connectionString,
      PLAKBOEK_URL: 'http://localhost:3000',
      PLAKBOEK_SECRET: 'bootstrap-test-secret-0123456789-abcdefghijk',
    });
    return {
      runtime: createRuntime(options.host ?? { config }, env),
      database,
    };
  }

  async function count(runtime: Runtime, table: string): Promise<number> {
    const rows = await runtime.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${table}`,
    );
    return Number(rows[0]?.n);
  }

  it('creates the superadmin and publishes the seed as the home page', async () => {
    const { runtime } = await freshInstallation();

    const result = await bootstrapInstallation(runtime, {
      name: 'Ada Lovelace',
      email: '  Ada@Example.COM ',
      password: PASSWORD,
    });

    expect(result.email).toBe('ada@example.com');
    expect(result.homePublished).toBe(true);
    expect(result.homePath).toBe('/');

    const users = await runtime.db.sql`SELECT id, role, name FROM "user"`;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: result.userId,
      role: 'superadmin',
      name: 'Ada Lovelace',
    });
    const accounts = await runtime.db.sql`
      SELECT provider_id, password FROM account WHERE user_id = ${result.userId}`;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider_id).toBe('credential');
    expect(accounts[0]?.password).not.toContain(PASSWORD);

    const response = await runtime.visitor(
      new Request('http://localhost:3000/'),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello world');

    const audit = await runtime.db.sql`
      SELECT action, actor_user_id, actor_role_key, outcome
      FROM audit_log ORDER BY id`;
    const actions = audit.map((row) => row.action);
    expect(actions.filter((action) => action === 'page.create')).toHaveLength(
      1,
    );
    expect(actions.filter((action) => action === 'block.insert')).toHaveLength(
      2,
    );
    expect(actions.filter((action) => action === 'page.publish')).toHaveLength(
      1,
    );
    for (const row of audit) {
      expect(row.actor_user_id).toBe(result.userId);
      expect(row.actor_role_key).toBe('superadmin');
      expect(row.outcome).toBe('allowed');
    }
  });

  it('refuses a second bootstrap and changes nothing', async () => {
    const { runtime } = await freshInstallation();
    await bootstrapInstallation(runtime, {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    });

    await expect(
      bootstrapInstallation(runtime, {
        name: 'Grace',
        email: 'grace@example.com',
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(InstallationNotEmptyError);

    expect(await count(runtime, '"user"')).toBe(1);
    expect(await count(runtime, 'pages')).toBe(1);
  });

  it.each([
    ['different addresses', 'ada@example.com', 'grace@example.com'],
    ['the same address', 'ada@example.com', 'ada@example.com'],
  ])(
    'serialises two concurrent bootstraps with %s: one user, one home page',
    async (_label, first, second) => {
      const { runtime } = await freshInstallation();

      const settled = await Promise.allSettled([
        bootstrapInstallation(runtime, {
          name: 'First',
          email: first,
          password: PASSWORD,
        }),
        bootstrapInstallation(runtime, {
          name: 'Second',
          email: second,
          password: PASSWORD,
        }),
      ]);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(InstallationNotEmptyError);

      expect(await count(runtime, '"user"')).toBe(1);
      expect(await count(runtime, 'pages')).toBe(1);
      const roles = await runtime.db.sql`SELECT role FROM "user"`;
      expect(roles.map((row) => row.role)).toEqual(['superadmin']);
      expect(await count(runtime, `"user" WHERE role = 'editor'`)).toBe(0);
    },
  );

  it('maps an unmigrated database to a disclosure-free DatabaseNotReadyError', async () => {
    const { runtime, database } = await freshInstallation({ migrate: false });
    const url = new URL(database.connectionString);

    const error = await bootstrapInstallation(runtime, {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseNotReadyError);
    const { message } = error as DatabaseNotReadyError;
    expect(message).toBe('The database is not ready');
    expect(message).not.toContain(url.pathname.slice(1));
    expect(message).not.toContain(url.port);
    expect(message).not.toContain(url.hostname);
    expect((error as DatabaseNotReadyError).cause).toBeDefined();
  });

  it('maps an unreachable server to DatabaseNotReadyError', async () => {
    const env = readRuntimeEnv({
      DATABASE_URL: 'postgres://nobody:secret@127.0.0.1:1/missing',
      PLAKBOEK_URL: 'http://localhost:3000',
      PLAKBOEK_SECRET: 'bootstrap-test-secret-0123456789-abcdefghijk',
    });
    const runtime = createRuntime({ config }, env);

    const error = await bootstrapInstallation(runtime, {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseNotReadyError);
    expect((error as Error).message).not.toContain('127.0.0.1');
    expect((error as Error).message).not.toContain('secret');
  });

  it('refuses a weak password before storing anything', async () => {
    const { runtime } = await freshInstallation();

    const error = await bootstrapInstallation(runtime, {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'short',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BootstrapValidationError);
    expect(
      (error as BootstrapValidationError).issues.map((issue) => issue.field),
    ).toEqual(['password']);
    expect((error as Error).message).not.toContain('short');
    expect(await count(runtime, '"user"')).toBe(0);
  });

  it('creates only the user when the config has no seed', async () => {
    const { runtime } = await freshInstallation({
      host: { config: { ...config, seed: null } },
    });

    const result = await bootstrapInstallation(runtime, {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    });

    expect(result.homePublished).toBe(false);
    expect(await count(runtime, '"user"')).toBe(1);
    expect(await count(runtime, 'pages')).toBe(0);
  });

  it('sets a password that better-auth signs in with', async () => {
    const { runtime } = await freshInstallation();
    await bootstrapInstallation(runtime, {
      name: 'Ada',
      email: 'Ada@Example.com',
      password: PASSWORD,
    });

    const signedIn = await runtime.auth.api.signInEmail({
      body: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(signedIn.user.email).toBe('ada@example.com');

    await expect(
      runtime.auth.api.signInEmail({
        body: { email: 'ada@example.com', password: `${PASSWORD}x` },
      }),
    ).rejects.toBeDefined();
  });
});
