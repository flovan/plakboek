// Throwaway database helper for the scaffold and deploy proofs. Plain
// TypeScript run by Node's type stripping:
//
//   node scripts/lib/create-database.ts create [adminUrl]
//   node scripts/lib/create-database.ts drop <name> [adminUrl]
//
// The admin URL comes from SCAFFOLD_ADMIN_URL when it is not given as an
// argument, so a caller can keep a password out of process lists. `create`
// prints the new database's URL on stdout and nothing else. Errors print the
// failure only, never the admin URL.
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DATABASE_NAME_PATTERN = /^[a-z0-9_]+$/;

/** Refuses anything that could change the meaning of a quoted identifier. */
function assertDatabaseName(name: string): string {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(`"${name}" is not a valid database name`);
  }
  return name;
}

function adminUrlFrom(argument: string | undefined): string {
  const url = argument ?? process.env.SCAFFOLD_ADMIN_URL;
  if (url === undefined || url === '') {
    throw new Error('no admin database URL: set SCAFFOLD_ADMIN_URL');
  }
  return url;
}

/** Removes the URL and its password from an error message. */
function redactOne(message: string, adminUrl: string | undefined): string {
  let out = message;
  if (adminUrl !== undefined && adminUrl !== '') {
    out = out.split(adminUrl).join('<database url>');
    try {
      const { password } = new URL(adminUrl);
      if (password !== '')
        out = out.split(decodeURIComponent(password)).join('***');
    } catch {
      // An unparsable URL has no password to hide beyond the replacement above.
    }
  }
  return out;
}

/** The admin URL may arrive as an argument or in the environment. */
function redact(message: string, candidates: readonly (string | undefined)[]) {
  return candidates.reduce<string>(
    (text, candidate) => redactOne(text, candidate),
    message,
  );
}

async function withAdminClient<T>(
  adminUrl: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function create(adminUrl: string): Promise<string> {
  const name = assertDatabaseName(
    `plakboek_scaffold_${randomBytes(6).toString('hex')}`,
  );
  await withAdminClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
  });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function drop(adminUrl: string, name: string): Promise<void> {
  const checked = assertDatabaseName(name);
  await withAdminClient(adminUrl, async (client) => {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [checked],
    );
    await client.query(`DROP DATABASE IF EXISTS "${checked}"`);
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'create') {
    process.stdout.write(`${await create(adminUrlFrom(rest[0]))}\n`);
    return;
  }
  if (command === 'drop' && rest[0] !== undefined) {
    await drop(adminUrlFrom(rest[1]), rest[0]);
    return;
  }
  throw new Error(
    'usage: create-database.ts create [adminUrl] | drop <name> [adminUrl]',
  );
}

const args = process.argv.slice(2);
try {
  await main(args);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `create-database: ${redact(message, [...args, process.env.SCAFFOLD_ADMIN_URL])}\n`,
  );
  process.exitCode = 1;
}
