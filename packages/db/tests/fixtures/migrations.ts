/**
 * Frozen `Migration` factories shared by every integration test in this
 * package (Task 1: happy-path registration/checksum/order; Task 2: partial
 * non-transactional/transactional failure re-runs and concurrent-migrator
 * races). Each factory returns a fresh frozen object so no test can mutate
 * another test's fixture by reference.
 */
import { STATEMENT_BREAKPOINT, type Migration } from '../../src/migrate.js';

export function createAlphaMigration(): Migration {
  return Object.freeze({
    name: '0001_create_alpha',
    sql: 'CREATE TABLE alpha (id serial primary key);',
    transactional: true,
  });
}

export function createBetaMigration(): Migration {
  return Object.freeze({
    name: '0002_create_beta',
    sql: 'CREATE TABLE beta (id serial primary key);',
    transactional: true,
  });
}

export function createGammaMigration(): Migration {
  return Object.freeze({
    name: '0003_create_gamma',
    sql: 'CREATE TABLE gamma (id serial primary key);',
    transactional: true,
  });
}

/** Ordered between alpha (0001) and gamma (0003) in a registry that never
 * applied it before -- used to prove MigrationOrderError when a new entry is
 * inserted before an already-applied migration. */
export function createInsertBeforeMigration(): Migration {
  return Object.freeze({
    name: '0002_insert_before',
    sql: 'CREATE TABLE insert_before (id serial primary key);',
    transactional: true,
  });
}

/** A transactional migration whose second statement fails (calling a
 * function that does not exist). Its first statement's DDL must not survive
 * the rollback -- proves transactional migrations roll back atomically. */
export function createBrokenTransactionalMigration(): Migration {
  return Object.freeze({
    name: '0001_broken_tx',
    sql: [
      'CREATE TABLE broken_tx_a (id serial primary key);',
      'SELECT plakboek_test_missing_function();',
    ].join('\n'),
    transactional: true,
  });
}

const PARTIAL_FAILURE_STATEMENTS = (
  tableA: string,
  indexName: string,
  tableB: string,
): string[] => [
  `CREATE TABLE IF NOT EXISTS ${tableA} (id serial primary key);`,
  `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableA} (id);`,
  [
    'DO $$',
    'BEGIN',
    "  IF to_regclass('public.partial_failure_gate') IS NULL THEN",
    "    RAISE EXCEPTION 'simulated failure: gate table missing';",
    '  END IF;',
    'END $$;',
  ].join('\n'),
  `CREATE TABLE IF NOT EXISTS ${tableB} (id serial primary key);`,
];

/** Non-transactional: four existence-guarded statements separated by
 * STATEMENT_BREAKPOINT. The third (a DO block) fails until a
 * `partial_failure_gate` table exists, simulating a migration that dies
 * partway through and must be safely re-runnable (D-03, success criterion
 * 5). Statements run independently, so partial_a and its index survive a
 * failed run while partial_b never gets created. */
export function createPartialSplitMigration(): Migration {
  return Object.freeze({
    name: '0001_partial_split',
    sql: PARTIAL_FAILURE_STATEMENTS(
      'partial_a',
      'partial_a_id_idx',
      'partial_b',
    ).join(`\n${STATEMENT_BREAKPOINT}\n`),
    transactional: false,
  });
}

/** The same four statements as `createPartialSplitMigration`, but joined
 * into a single transactional migration -- proves a transactional failure
 * rolls back everything, including the first (otherwise idempotent)
 * statement, unlike the non-transactional variant. */
export function createPartialTransactionalMigration(): Migration {
  return Object.freeze({
    name: '0001_partial_tx',
    sql: PARTIAL_FAILURE_STATEMENTS(
      'partial_tx_a',
      'partial_tx_a_id_idx',
      'partial_tx_b',
    ).join('\n'),
    transactional: true,
  });
}

/** Transactional, deliberately slow (pg_sleep) migration with an unguarded
 * CREATE TABLE -- used to prove that two concurrent migrators racing under
 * `withMigrationLock` never both apply it (success criterion 5), and that
 * two unlocked `applyPendingMigrations` calls racing on separate clients can
 * genuinely double-attempt it (the negative control). */
export function createSlowRaceMigration(): Migration {
  return Object.freeze({
    name: '0001_slow_race',
    sql: 'SELECT pg_sleep(1);\nCREATE TABLE race_target (id serial primary key);',
    transactional: true,
  });
}
