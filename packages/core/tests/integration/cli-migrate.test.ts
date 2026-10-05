/**
 * `plakboek migrate` as a spawned process against real Postgres: live
 * progress, the exactly-once guarantee between two concurrent deploys, the
 * bounded lock wait, URL precedence, `.env` loading and the exit codes.
 */
import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { linesStartingWith, runCli } from './cli-helpers.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const MIGRATION_LOCK_KEY = '4839120657231098713';
const MIGRATIONS_DIR = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'db',
  'src',
  'migrations',
);
const REGISTRY_LENGTH = readdirSync(MIGRATIONS_DIR).filter((name) =>
  /^\d{4}_[a-z0-9_]+\.ts$/.test(name),
).length;

const databases: TestDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function freshDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  databases.push(database);
  return database;
}

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'plakboek-cli-'));
  directories.push(directory);
  return directory;
}

async function appliedRows(connectionString: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM plakboek_migrations',
    );
    return result.rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

async function migrationsTableExists(
  connectionString: string,
): Promise<boolean> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.plakboek_migrations') IS NOT NULL AS exists",
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

describe('plakboek migrate', () => {
  it('prints one Applying line per migration and a summary, then Nothing to apply', async () => {
    const database = await freshDatabase();
    const env = { DATABASE_URL: database.connectionString };

    const first = await runCli(['migrate'], { env });
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    const applying = linesStartingWith(first.stdout, 'Applying ');
    expect(applying).toHaveLength(REGISTRY_LENGTH);
    expect(applying[0]).toMatch(/^Applying 0001_/);
    expect(first.stdout).toContain(
      `Migrations are up to date (${String(REGISTRY_LENGTH)} applied).`,
    );
    expect(await appliedRows(database.connectionString)).toBe(REGISTRY_LENGTH);

    const second = await runCli(['migrate'], { env });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('Nothing to apply.');
    expect(linesStartingWith(second.stdout, 'Applying ')).toHaveLength(0);
  });

  it('applies every migration exactly once when two migrators start together', async () => {
    const database = await freshDatabase();
    const env = { DATABASE_URL: database.connectionString };

    const [a, b] = await Promise.all([
      runCli(['migrate'], { env }),
      runCli(['migrate'], { env }),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(await appliedRows(database.connectionString)).toBe(REGISTRY_LENGTH);
    const applyingLines = [
      ...linesStartingWith(a.stdout, 'Applying '),
      ...linesStartingWith(b.stdout, 'Applying '),
    ];
    expect(applyingLines).toHaveLength(REGISTRY_LENGTH);
    expect(new Set(applyingLines).size).toBe(REGISTRY_LENGTH);
  });

  it('waits once for a held lock, then gives up with exit 1 and applies nothing', async () => {
    const database = await freshDatabase();
    const holder = new Client({ connectionString: database.connectionString });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [
      MIGRATION_LOCK_KEY,
    ]);
    try {
      const result = await runCli(['migrate', '--lock-wait', '1'], {
        env: { DATABASE_URL: database.connectionString },
      });

      expect(result.code).toBe(1);
      expect(
        linesStartingWith(
          result.stdout,
          'Waiting for the migration lock (another process holds it)',
        ),
      ).toHaveLength(1);
      expect(result.stderr).toContain(
        'Error: Gave up waiting for the migration lock after 1s. Nothing was applied. Retry when the other deploy finishes.',
      );
      expect(result.stderr).toContain(
        'Migrations need a direct (session) database connection, not a pooler.',
      );
      expect(linesStartingWith(result.stdout, 'Applying ')).toHaveLength(0);
    } finally {
      await holder.end();
    }
    expect(await appliedRows(database.connectionString)).toBe(0);
  });

  it('reads the wait from PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS', async () => {
    const database = await freshDatabase();
    const holder = new Client({ connectionString: database.connectionString });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [
      MIGRATION_LOCK_KEY,
    ]);
    try {
      const result = await runCli(['migrate'], {
        env: {
          DATABASE_URL: database.connectionString,
          PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS: '1',
        },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('after 1s');
    } finally {
      await holder.end();
    }
  });

  it('fails with exit 1 and the fixed copy when DATABASE_URL is not set', async () => {
    const result = await runCli(['migrate'], { cwd: scratchDirectory() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: DATABASE_URL is not set. Set it in .env or the environment.',
    );
  });

  it('migrates through DATABASE_MIGRATION_URL when DATABASE_URL is unusable', async () => {
    const database = await freshDatabase();
    const result = await runCli(['migrate'], {
      env: {
        DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:1/nothing',
        DATABASE_MIGRATION_URL: database.connectionString,
      },
    });
    expect(result.code).toBe(0);
    expect(await appliedRows(database.connectionString)).toBe(REGISTRY_LENGTH);
  });

  it('reports an unreachable database without echoing any part of the URL', async () => {
    const result = await runCli(['migrate'], {
      env: {
        DATABASE_URL: 'postgres://someuser:s3cret-pass@127.0.0.1:1/somedb',
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: Could not connect to the database. Check DATABASE_URL; migrations need a direct (session) connection, not a pooler.',
    );
    const everything = result.stdout + result.stderr;
    for (const fragment of ['someuser', 's3cret-pass', 'somedb', '127.0.0.1']) {
      expect(everything).not.toContain(fragment);
    }
  });

  it('rejects a DATABASE_URL that is not a postgres url without echoing it', async () => {
    const result = await runCli(['migrate'], {
      env: { DATABASE_URL: 'mysql://someuser:s3cret-pass@host/db' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL must be a postgres://');
    expect(result.stderr).not.toContain('s3cret-pass');
  });

  it('exits 2 with usage on a bad flag value, an unknown flag or an unknown command', async () => {
    for (const args of [
      ['migrate', '--lock-wait', 'x'],
      ['migrate', '--lock-wait', '-3'],
      ['migrate', '--bogus'],
      ['frobnicate'],
      [],
    ]) {
      const result = await runCli(args, {
        env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/d' },
      });
      expect([args.join(' '), result.code]).toEqual([args.join(' '), 2]);
      expect(result.stderr).toContain('Usage:');
    }
  });

  it('prints help (exit 0) stating host schemas are not migrated, and the version', async () => {
    const help = await runCli(['migrate', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--lock-wait');
    expect(help.stdout.toLowerCase()).toContain('host');

    const version = await runCli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('loads .env from the working directory without overriding set variables', async () => {
    const database = await freshDatabase();
    const directory = scratchDirectory();
    writeFileSync(
      join(directory, '.env'),
      `DATABASE_URL=${database.connectionString}\n`,
    );

    const fromFile = await runCli(['migrate'], { cwd: directory });
    expect(fromFile.code).toBe(0);
    expect(await migrationsTableExists(database.connectionString)).toBe(true);

    const other = await freshDatabase();
    const environmentWins = await runCli(['migrate'], {
      cwd: directory,
      env: { DATABASE_URL: other.connectionString },
    });
    expect(environmentWins.code).toBe(0);
    expect(await appliedRows(other.connectionString)).toBe(REGISTRY_LENGTH);
  });
});
