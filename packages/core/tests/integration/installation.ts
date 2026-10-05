/**
 * Test harness for the built fixture host: a migrated, bootstrapped database,
 * the process environment the built server reads, and a started server.
 */
import { SUPERADMIN_ROLE_KEY } from '@plakboek/auth';
import { runMigrations } from '@plakboek/db';
import { bootstrapInstallation } from '../../src/runtime/bootstrap.js';
import { closeAllDbs } from '../../src/runtime/db.js';
import { readRuntimeEnv } from '../../src/runtime/env.js';
import { createRuntime, type Runtime } from '../../src/runtime/runtime.js';
import { createServer, type RunningServer } from '../../src/server.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const ENV_KEYS = ['DATABASE_URL', 'PLAKBOEK_URL', 'PLAKBOEK_SECRET'] as const;

export type Installation = {
  readonly runtime: Runtime;
  /** The bootstrapped superadmin, shaped as the page engine's actor. */
  readonly actor: { readonly userId: string; readonly roleKey: string };
  /** Starts the server of one fixture build against this installation. */
  serve(build: { serverEntry: string; clientDir: string }): Promise<{
    readonly url: (path: string) => string;
    close(): Promise<void>;
  }>;
  /** Stops every server, restores the environment and drops the database. */
  dispose(): Promise<void>;
};

/**
 * Creates and migrates a fresh database, bootstraps the fixture's first
 * superadmin (which publishes the seed home page) and points the process
 * environment at it.
 */
export async function createInstallation(): Promise<Installation> {
  const database: TestDatabase = await createTestDatabase();
  await runMigrations({ connectionString: database.connectionString });

  const { default: config } =
    await import('../fixture-host/plakboek.config.ts');
  const environment = {
    DATABASE_URL: database.connectionString,
    PLAKBOEK_URL: 'http://localhost:3000',
    PLAKBOEK_SECRET: 'installation-test-secret-0123456789-abcdefghijk',
  };
  const runtime = createRuntime({ config }, readRuntimeEnv(environment));
  const result = await bootstrapInstallation(runtime, {
    name: 'Owner',
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });

  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = environment[key];
  }

  const running: RunningServer[] = [];
  return {
    runtime,
    actor: { userId: result.userId, roleKey: SUPERADMIN_ROLE_KEY },
    async serve(build) {
      const server = await createServer({
        buildPath: build.serverEntry,
        clientDir: build.clientDir,
        port: 0,
      }).start();
      running.push(server);
      return {
        url: (path) => `http://127.0.0.1:${server.port}${path}`,
        close: () => server.close(),
      };
    },
    async dispose() {
      await Promise.all(running.splice(0).map((server) => server.close()));
      await closeAllDbs();
      for (const key of ENV_KEYS) {
        const value = previous.get(key);
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      await database.drop();
    },
  };
}
