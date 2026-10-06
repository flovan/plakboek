/**
 * The first-run page against real Postgres: the form only at zero users, the
 * 422/409/503/403 answers, the host 404 afterwards, the parallel-submit race,
 * and one pass through the built fixture app.
 */
import { runMigrations } from '@plakboek/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeAllDbs } from '../../src/runtime/db.js';
import { readRuntimeEnv } from '../../src/runtime/env.js';
import { createRuntime, type Runtime } from '../../src/runtime/runtime.js';
import { SETUP_CSP } from '../../src/setup/styles.js';
import { handleSetupGet, handleSetupPost } from '../../src/setup/handlers.js';
import { verifyTestEmailToken } from '../../src/setup/token.js';
import type { PlakboekConfig } from '../../src/types.js';
import { FIXTURE_CLIENT_DIR, FIXTURE_SERVER_ENTRY } from './fixture-host.js';
import {
  createEmptyInstallation,
  type EmptyInstallation,
} from './installation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const SECRET = 'setup-test-secret-0123456789-abcdefghijklmn';
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

function formRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = { Origin: ORIGIN },
  url = `${ORIGIN}/cms/setup`,
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: PASSWORD,
  passwordConfirm: PASSWORD,
};

function expectSetupHeaders(response: Response): void {
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(response.headers.get('Content-Security-Policy')).toBe(SETUP_CSP);
}

describe('the setup handlers', () => {
  let config: PlakboekConfig;
  const databases: TestDatabase[] = [];

  beforeAll(async () => {
    ({ default: config } = await import('../fixture-host/plakboek.config.ts'));
  });

  afterEach(async () => {
    await closeAllDbs();
    for (const database of databases.splice(0)) await database.drop();
  });

  async function freshRuntime(
    options: { migrate?: boolean } = {},
  ): Promise<{ runtime: Runtime; database: TestDatabase }> {
    const database = await createTestDatabase();
    databases.push(database);
    if (options.migrate !== false) {
      await runMigrations({ connectionString: database.connectionString });
    }
    const env = readRuntimeEnv({
      DATABASE_URL: database.connectionString,
      PLAKBOEK_URL: ORIGIN,
      PLAKBOEK_SECRET: SECRET,
    });
    return { runtime: createRuntime({ config }, env), database };
  }

  async function userCount(runtime: Runtime): Promise<number> {
    const rows = await runtime.db.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM "user"`;
    return rows[0]?.n ?? 0;
  }

  it('serves the form at zero users with the setup headers', async () => {
    const { runtime } = await freshRuntime();
    const response = await handleSetupGet(
      new Request(`${ORIGIN}/cms/setup`),
      runtime,
    );
    expect(response.status).toBe(200);
    expectSetupHeaders(response);
    const body = await response.text();
    expect(body).toContain('<h1>Set up Plakboek</h1>');
    expect(body).toContain('Create superadmin');
    expect(body).not.toContain('<script');
  });

  it('creates the superadmin, publishes home and shows the done screen', async () => {
    const { runtime } = await freshRuntime();
    const response = await handleSetupPost(formRequest(valid), runtime);

    expect(response.status).toBe(200);
    expectSetupHeaders(response);
    const body = await response.text();
    expect(body).toContain('Setup complete');
    expect(body).toContain(
      'The superadmin account for ada@example.com was created and your home page is published.',
    );
    expect(response.headers.get('Set-Cookie')).toBeNull();

    const token = /name="token" value="([^"]+)"/.exec(body)?.[1];
    const users = await runtime.db.sql`SELECT id, role_key AS role FROM "user"`;
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('superadmin');
    expect(token).toBeDefined();
    expect(verifyTestEmailToken(token ?? '', { secret: SECRET })).toMatchObject(
      { userId: users[0]?.id, homePublished: true },
    );

    const pages = await runtime.db
      .sql`SELECT count(*)::int AS n FROM page WHERE status = 'published'`;
    expect(pages[0]?.n).toBe(1);
  });

  it('answers the host 404 to a GET once a user exists, without naming setup', async () => {
    const { runtime } = await freshRuntime();
    await handleSetupPost(formRequest(valid), runtime);

    const response = await handleSetupGet(
      new Request(`${ORIGIN}/cms/setup`),
      runtime,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.text()).toLowerCase()).not.toContain('setup');
  });

  it('answers 409 to a POST once a user exists and creates no second user', async () => {
    const { runtime } = await freshRuntime();
    await handleSetupPost(formRequest(valid), runtime);

    const response = await handleSetupPost(
      formRequest({ ...valid, email: 'grace@example.com' }),
      runtime,
    );
    expect(response.status).toBe(409);
    expectSetupHeaders(response);
    expect(await response.text()).toContain('Setup is already complete');
    expect(await userCount(runtime)).toBe(1);
  });

  it('re-renders with 422, a summary, kept name and email and empty passwords', async () => {
    const { runtime } = await freshRuntime();
    const response = await handleSetupPost(
      formRequest({
        name: '   ',
        email: '<b>nope</b>',
        password: 'shortpass11',
        passwordConfirm: 'different',
      }),
      runtime,
    );

    expect(response.status).toBe(422);
    expectSetupHeaders(response);
    const body = await response.text();
    expect(body).toContain('Fix the following and try again');
    expect(body).toContain('Name: enter your name.');
    expect(body).toContain(
      'Email address: enter an address like name@example.com.',
    );
    expect(body).toContain('Password: use at least 12 characters.');
    expect(body).toContain('Confirm password: the two passwords do not match.');
    expect(body.match(/<li>/g)).toHaveLength(4);
    expect(body).toContain('&lt;b&gt;nope&lt;/b&gt;');
    expect(body).not.toContain('<b>nope</b>');
    expect(body).not.toContain('shortpass11');
    expect(body).not.toContain('different');
    expect(await userCount(runtime)).toBe(0);
  });

  it('refuses a cross-origin POST with 403 before any work', async () => {
    const { runtime } = await freshRuntime();
    const response = await handleSetupPost(
      formRequest(valid, { Origin: 'https://evil.example' }),
      runtime,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await userCount(runtime)).toBe(0);
  });

  it('accepts the request own origin as well as PLAKBOEK_URL', async () => {
    const { runtime } = await freshRuntime();
    const response = await handleSetupPost(
      formRequest(
        valid,
        { Origin: 'http://127.0.0.1:9' },
        'http://127.0.0.1:9/cms/setup',
      ),
      runtime,
    );
    expect(response.status).toBe(200);
  });

  it('lets exactly one of two parallel valid submissions win', async () => {
    const { runtime } = await freshRuntime();
    const responses = await Promise.all([
      handleSetupPost(formRequest(valid), runtime),
      handleSetupPost(
        formRequest({ ...valid, email: 'grace@example.com' }),
        runtime,
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await userCount(runtime)).toBe(1);
  });

  it('answers 503 on an unmigrated database without connection details', async () => {
    const { runtime, database } = await freshRuntime({ migrate: false });
    const response = await handleSetupGet(
      new Request(`${ORIGIN}/cms/setup`),
      runtime,
    );

    expect(response.status).toBe(503);
    expectSetupHeaders(response);
    const body = await response.text();
    expect(body).toContain('The database is not ready');
    expect(body).toContain('pnpm plakboek migrate');
    const { pathname, port } = new URL(database.connectionString);
    expect(body).not.toContain(pathname.slice(1));
    expect(body).not.toContain(`:${port}`);

    const posted = await handleSetupPost(formRequest(valid), runtime);
    expect(posted.status).toBe(503);
  });
});

describe('the setup page through the built fixture app', () => {
  let installation: EmptyInstallation;
  let url: (path: string) => string;

  beforeAll(async () => {
    installation = await createEmptyInstallation();
    ({ url } = await installation.serve({
      serverEntry: FIXTURE_SERVER_ENTRY,
      clientDir: FIXTURE_CLIENT_DIR,
    }));
  });

  afterAll(async () => {
    await installation?.dispose();
  });

  it('serves the form, creates the account, then answers the host 404', async () => {
    const form = await fetch(url('/cms/setup'));
    expect(form.status).toBe(200);
    expectSetupHeaders(form);
    expect(await form.text()).toContain('Set up Plakboek');

    const created = await fetch(url('/cms/setup'), {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: new URLSearchParams(valid),
    });
    expect(created.status).toBe(200);
    expectSetupHeaders(created);
    expect(await created.text()).toContain('Setup complete');

    const home = await fetch(url('/'));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Hello world');

    const gone = await fetch(url('/cms/setup'));
    expect(gone.status).toBe(404);
    const body = await gone.text();
    expect(body).toContain('Page not found');
    expect(body.toLowerCase()).not.toContain('setup');
  });
});
