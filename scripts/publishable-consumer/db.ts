import {
  MigrationChecksumMismatchError,
  createDb,
  runMigrations,
  type Db,
  type Migration,
  type RunMigrationsOptions,
  type RunMigrationsResult,
} from '@plakboek/db';

if (typeof createDb !== 'function') {
  process.exit(1);
}

if (typeof runMigrations !== 'function') {
  process.exit(1);
}

if (typeof MigrationChecksumMismatchError !== 'function') {
  process.exit(1);
}

function makeDb(connectionString: string): Db {
  return createDb({ connectionString });
}

async function applyMigrations(
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  return runMigrations(options);
}

const exampleMigration: Migration = {
  name: '0001_example',
  sql: 'select 1;',
  transactional: true,
};

// Must not open a connection: no createDb()/runMigrations() call here, just
// the type-of checks and type assignments above.
console.log(
  'db.ts: createDb/runMigrations/MigrationChecksumMismatchError are exported as functions (no connection opened)',
  typeof makeDb,
  typeof applyMigrations,
  exampleMigration.name,
);
