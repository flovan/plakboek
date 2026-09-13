const mod = await import('@plakboek/db');

if (typeof mod.createDb !== 'function') {
  process.exit(1);
}

if (typeof mod.runMigrations !== 'function') {
  process.exit(1);
}

if (typeof mod.MigrationChecksumMismatchError !== 'function') {
  process.exit(1);
}

// Must not open a connection: no createDb()/runMigrations() call here, just
// the type-of checks above.
console.log(
  'db.mjs: createDb/runMigrations/MigrationChecksumMismatchError are exported as functions (no connection opened)',
);
