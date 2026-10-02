/**
 * An instrumented database for the visitor path: a logging Drizzle instance
 * over the test database, plus parsers that read the logged SQL.
 *
 * The handler under test is given ONLY this database, so every statement a
 * visitor request issues lands in `statements`. Page writes in a test keep
 * using the fixture's normal handle, which is why a non-empty log is itself
 * evidence that the instrument is wired to the handler.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PagesDeps } from '@plakboek/pages';

export type CountingDb = {
  readonly db: PagesDeps['db'];
  /** Every statement issued through `db`, in order. */
  readonly statements: string[];
  reset(): void;
  close(): Promise<void>;
};

export function createCountingDb(connectionString: string): CountingDb {
  const statements: string[] = [];
  const client = postgres(connectionString, { max: 4 });
  const db = drizzle({
    client,
    logger: {
      logQuery(query: string): void {
        statements.push(query);
      },
    },
  });
  return {
    db,
    statements,
    reset(): void {
      statements.length = 0;
    },
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
  };
}

/** A double-quoted identifier, with a doubled quote as an escaped quote. */
const IDENTIFIER = '"((?:[^"]|"")+)"';

function unquote(identifier: string): string {
  return identifier.replaceAll('""', '"');
}

/**
 * Every table named after `from` or a `join`, which is where Drizzle writes a
 * table it reads. A schema qualifier (`"public"."pages"`) is dropped.
 */
export function tablesTouched(
  statements: readonly string[],
): ReadonlySet<string> {
  const tables = new Set<string>();
  const reference = new RegExp(
    `\\b(?:from|join)\\s+(?:${IDENTIFIER}\\.)?${IDENTIFIER}`,
    'gi',
  );
  for (const statement of statements) {
    for (const match of statement.matchAll(reference)) {
      const table = match[2];
      if (table !== undefined) tables.add(unquote(table));
    }
  }
  return tables;
}

/**
 * Every `"table"."column"` reference, grouped by table. A column that is
 * written unqualified would be invisible here, so the statements must be
 * Drizzle's qualified form (a joined select always is).
 */
export function qualifiedColumns(
  statements: readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const columns = new Map<string, Set<string>>();
  const reference = new RegExp(`${IDENTIFIER}\\.${IDENTIFIER}`, 'g');
  for (const statement of statements) {
    for (const match of statement.matchAll(reference)) {
      const table = match[1];
      const column = match[2];
      if (table === undefined || column === undefined) continue;
      const names = columns.get(unquote(table)) ?? new Set<string>();
      names.add(unquote(column));
      columns.set(unquote(table), names);
    }
  }
  return columns;
}
