/**
 * `plakboek bootstrap` as a spawned process against real Postgres, loading the
 * fixture host's TypeScript config through tsx. A seeded success proves the
 * CLI's block registry is the one the config populated; the rest pin the
 * exit codes, the password intake rules and that no secret is ever echoed
 * (every run is checked for the password and the database URL).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '@plakboek/db';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_DIR } from './fixture-host.js';
import { runCli, type CliResult } from './cli-helpers.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'cli-bootstrap-test-secret-0123456789-abcdefghijk';

const databases: TestDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function installation(
  options: { migrate?: boolean } = {},
): Promise<{ database: TestDatabase; env: Record<string, string> }> {
  const database = await createTestDatabase();
  databases.push(database);
  if (options.migrate !== false) {
    await runMigrations({ connectionString: database.connectionString });
  }
  return {
    database,
    env: {
      DATABASE_URL: database.connectionString,
      PLAKBOEK_URL: 'http://localhost:3000',
      PLAKBOEK_SECRET: SECRET,
    },
  };
}

/** Runs the CLI from the fixture host (its tsconfig applies) and records the
 * output for the no-secrets check. */
async function bootstrap(
  args: readonly string[],
  options: {
    env: Record<string, string>;
    stdin?: string;
    cwd?: string;
  },
): Promise<CliResult> {
  const result = await runCli(['bootstrap', ...args], {
    cwd: options.cwd ?? FIXTURE_DIR,
    env: options.env,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  const secrets = [PASSWORD, '12345678901'];
  const url = options.env.DATABASE_URL;
  if (url !== undefined) secrets.push(url, new URL(url).password);
  // Whatever a run printed, neither the password nor the database URL may be
  // in it.
  for (const secret of secrets.filter((value) => value.length > 0)) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
  return result;
}

async function query<T extends Record<string, unknown>>(
  connectionString: string,
  text: string,
): Promise<T[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const identity = ['--name', 'Ada Lovelace', '--email', 'Ada@Example.com'];

describe('plakboek bootstrap', () => {
  it('creates the superadmin and publishes the seeded home page', async () => {
    const { database, env } = await installation();

    const result = await bootstrap([...identity, '--password-stdin'], {
      env,
      stdin: `${PASSWORD}\n`,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      'Created superadmin ada@example.com.',
      'Published the home page at /.',
    ]);
    const users = await query<{ role_key: string }>(
      database.connectionString,
      'SELECT role_key FROM "user"',
    );
    expect(users).toEqual([{ role_key: 'superadmin' }]);
    const pages = await query<{ status: string; title: string }>(
      database.connectionString,
      'SELECT status, title FROM pages',
    );
    expect(pages).toEqual([{ status: 'published', title: 'Home' }]);
    const blocks = await query<{ block_type: string }>(
      database.connectionString,
      'SELECT block_type FROM blocks ORDER BY block_type',
    );
    expect(blocks.map((row) => row.block_type)).toEqual(['heading', 'section']);
  });

  it('takes the password from PLAKBOEK_BOOTSTRAP_PASSWORD and refuses a second run', async () => {
    const { database, env } = await installation();
    const withPassword = { ...env, PLAKBOEK_BOOTSTRAP_PASSWORD: PASSWORD };

    const first = await bootstrap(identity, { env: withPassword });
    expect(first.code).toBe(0);

    const second = await bootstrap(
      ['--name', 'Grace', '--email', 'grace@example.com'],
      { env: withPassword },
    );
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      'Error: This installation already has users. Bootstrap only runs on an empty installation.',
    );
    const users = await query(
      database.connectionString,
      'SELECT id FROM "user"',
    );
    expect(users).toHaveLength(1);
  });

  it('rejects a password that is too short with exit 2', async () => {
    const { env } = await installation();
    const result = await bootstrap([...identity, '--password-stdin'], {
      env,
      stdin: '12345678901\n',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: The password must be at least 12 characters.',
    );
  });

  it('rejects an invalid email with the field copy and exit 2', async () => {
    const { env } = await installation();
    const result = await bootstrap(
      ['--name', 'Ada', '--email', 'not-an-email', '--password-stdin'],
      { env, stdin: `${PASSWORD}\n` },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: Email address: enter an address like name@example.com.',
    );
  });

  it('fails with exit 2 when a value is missing and input is not interactive', async () => {
    const { env } = await installation();

    const noPassword = await bootstrap(identity, { env });
    expect(noPassword.code).toBe(2);
    expect(noPassword.stderr).toContain(
      'Error: --password-stdin or PLAKBOEK_BOOTSTRAP_PASSWORD is required when input is not interactive.',
    );

    const noEmail = await bootstrap(['--name', 'Ada'], {
      env: { ...env, PLAKBOEK_BOOTSTRAP_PASSWORD: PASSWORD },
    });
    expect(noEmail.code).toBe(2);
    expect(noEmail.stderr).toContain(
      'Error: --email is required when input is not interactive.',
    );

    const noName = await bootstrap(['--email', 'ada@example.com'], {
      env: { ...env, PLAKBOEK_BOOTSTRAP_PASSWORD: PASSWORD },
    });
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain(
      'Error: --name is required when input is not interactive.',
    );
  });

  it('does not accept the password as a flag value', async () => {
    const { env } = await installation();
    const result = await bootstrap([...identity, '--password', PASSWORD], {
      env,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('reports an unmigrated database', async () => {
    const { env } = await installation({ migrate: false });
    const result = await bootstrap([...identity, '--password-stdin'], {
      env,
      stdin: `${PASSWORD}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: The database is not ready. Run plakboek migrate first.',
    );
  });

  it('lists the environment problems, with the secret generation command', async () => {
    const { env } = await installation();
    const withoutSecret = Object.fromEntries(
      Object.entries(env).filter(([key]) => key !== 'PLAKBOEK_SECRET'),
    );
    const result = await bootstrap([...identity, '--password-stdin'], {
      env: withoutSecret,
      stdin: `${PASSWORD}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PLAKBOEK_SECRET');
    expect(result.stderr).toContain('randomBytes(32)');
  });

  it('fails clearly when the config file does not default-export defineConfig', async () => {
    const { env } = await installation();
    const directory = mkdtempSync(join(tmpdir(), 'plakboek-cli-config-'));
    directories.push(directory);
    const path = join(directory, 'plakboek.config.ts');
    writeFileSync(path, 'export default { nothing: true };\n');

    const result = await bootstrap(
      [...identity, '--password-stdin', '--config', path],
      { env, stdin: `${PASSWORD}\n` },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Error: ${path} must default-export defineConfig({...}).`,
    );
  });

  it('fails clearly when the config file does not exist', async () => {
    const { env } = await installation();
    const result = await bootstrap(
      [...identity, '--password-stdin', '--config', 'missing.config.ts'],
      { env, stdin: `${PASSWORD}\n` },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing.config.ts');
  });
});
