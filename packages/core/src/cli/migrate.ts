/**
 * `plakboek migrate`: the deploy's migration step (D-03). It applies the core
 * package's migrations under the session advisory lock and never loads the
 * host config, so it runs before the host builds or boots. Only the core
 * migrations run here: a host's own Drizzle schema has its own migration
 * history and is migrated by the host's own tooling.
 */
import {
  DbConfigError,
  MigrationChecksumMismatchError,
  MigrationFailedError,
  MigrationLockTimeoutError,
  MigrationOrderError,
  MigrationRegistryError,
  UnknownAppliedMigrationError,
  runMigrations,
} from '@plakboek/db';
import { errorCodes, isDatabaseNotReady } from '../runtime/db.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  UsageError,
  connectionSecrets,
  messageOf,
  oneLine,
  parseFlags,
  printError,
  printErrorLine,
  printLine,
} from './output.js';

export const MIGRATE_HELP = `Usage: plakboek migrate [--lock-wait <seconds>]

Applies the Plakboek core database migrations, in order, once each. Two deploys
that run this at the same time cannot double-apply: the second waits for the
first.

Options:
  --lock-wait <seconds>  How long to wait for another migrator before giving up
                         (default 120; or PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS)
  -h, --help             Show this help

Environment:
  DATABASE_MIGRATION_URL  Direct (session) connection used for migrations only;
                          falls back to DATABASE_URL
  DATABASE_URL            Postgres connection string

Only the core migrations run here. A host's own Drizzle schema is not migrated
by this command; run the host's own migration tooling for it.`;

const DEFAULT_LOCK_WAIT_SECONDS = 120;
const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//i;
const POOLER_HINT =
  'Migrations need a direct (session) database connection, not a pooler.';

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function parseSeconds(value: string, source: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`${source} must be a whole number of seconds.`);
  }
  return Number(value.trim());
}

/** Whether `error` means the server could not be reached or refused us. */
function isConnectionFailure(error: unknown): boolean {
  return (
    error instanceof DbConfigError ||
    isDatabaseNotReady(error) ||
    // Class 28: invalid authorisation (wrong user or password).
    errorCodes(error).some((code) => code.startsWith('28'))
  );
}

function failedMigrationCopy(
  error: MigrationFailedError,
  secrets: readonly string[],
): string {
  const cause = oneLine(
    messageOf(error.cause ?? error).replace(/\.$/, ''),
    secrets,
  );
  return error.statementIndex === undefined
    ? `Migration ${error.migrationName} failed: ${cause}. It was rolled back; fix it and run again.`
    : `Migration ${error.migrationName} failed at statement ${String(error.statementIndex)}: ${cause}. Its statements are existence-guarded; fix it and run again.`;
}

export async function runMigrateCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values } = parseFlags(argv, {
    'lock-wait': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    printLine(MIGRATE_HELP);
    return EXIT_OK;
  }

  const flagWait = values['lock-wait'];
  const envWait = env.PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS;
  const lockWaitSeconds =
    flagWait !== undefined
      ? parseSeconds(flagWait, '--lock-wait')
      : blank(envWait)
        ? DEFAULT_LOCK_WAIT_SECONDS
        : parseSeconds(envWait ?? '', 'PLAKBOEK_MIGRATION_LOCK_WAIT_SECONDS');

  const variable = blank(env.DATABASE_MIGRATION_URL)
    ? 'DATABASE_URL'
    : 'DATABASE_MIGRATION_URL';
  const connectionString = env[variable]?.trim() ?? '';
  if (connectionString.length === 0) {
    printError('DATABASE_URL is not set. Set it in .env or the environment.');
    return EXIT_FAILURE;
  }
  if (!POSTGRES_URL_PATTERN.test(connectionString)) {
    printError(
      `${variable} must be a postgres:// or postgresql:// connection string.`,
    );
    return EXIT_FAILURE;
  }
  const secrets = connectionSecrets(connectionString);

  try {
    const result = await runMigrations({
      connectionString,
      lockWaitMs: lockWaitSeconds * 1000,
      onLockWait: () => {
        printLine('Waiting for the migration lock (another process holds it)');
      },
      onMigrationStart: (name) => {
        printLine(`Applying ${name}`);
      },
    });
    if (result.applied.length === 0) {
      printLine('Nothing to apply.');
    } else {
      const total = result.alreadyApplied.length + result.applied.length;
      printLine(`Migrations are up to date (${String(total)} applied).`);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof MigrationLockTimeoutError) {
      printError(
        `Gave up waiting for the migration lock after ${String(lockWaitSeconds)}s. Nothing was applied. Retry when the other deploy finishes.`,
      );
      printErrorLine(POOLER_HINT);
    } else if (error instanceof MigrationFailedError) {
      printError(failedMigrationCopy(error, secrets));
    } else if (
      error instanceof MigrationRegistryError ||
      error instanceof MigrationChecksumMismatchError ||
      error instanceof UnknownAppliedMigrationError ||
      error instanceof MigrationOrderError
    ) {
      printError(oneLine(error.message, secrets));
    } else if (isConnectionFailure(error)) {
      printError(
        `Could not connect to the database. Check ${variable}; migrations need a direct (session) connection, not a pooler.`,
      );
    } else {
      printError(oneLine(messageOf(error), secrets));
    }
    return EXIT_FAILURE;
  }
}
