/**
 * One database handle per connection string for the whole process, held on
 * `globalThis` so a dev reload that re-evaluates the runtime never opens a
 * second pool.
 */
import { createDb, type Db } from '@plakboek/db';

const REGISTRY_KEY = Symbol.for('plakboek.db');

type Registry = Map<string, Db>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let existing = holder[REGISTRY_KEY];
  if (existing === undefined) {
    existing = new Map();
    holder[REGISTRY_KEY] = existing;
  }
  return existing;
}

/** The shared handle for a connection string, created on first use. */
export function getDb(connectionString: string): Db {
  const handles = registry();
  let handle = handles.get(connectionString);
  if (handle === undefined) {
    handle = createDb({ connectionString });
    handles.set(connectionString, handle);
  }
  return handle;
}

/** Closes every pooled handle and forgets them (shutdown and tests). */
export async function closeAllDbs(): Promise<void> {
  const handles = registry();
  const open = [...handles.values()];
  handles.clear();
  await Promise.all(open.map((handle) => handle.close()));
}

/** Postgres error codes that mean "the database is not usable yet". */
const NOT_READY_PG_CODES: ReadonlySet<string> = new Set([
  '42P01', // undefined_table: migrations have not run
  '3D000', // invalid_catalog_name: the database does not exist
  '57P03', // cannot_connect_now: the server is starting up
]);

/** Node network error codes for an unreachable server. */
const NOT_READY_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

const MAX_CAUSE_DEPTH = 8;

/** Every `code` in an error's `cause` chain and aggregated `errors`. */
export function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number): void => {
    if (
      depth > MAX_CAUSE_DEPTH ||
      typeof candidate !== 'object' ||
      candidate === null ||
      seen.has(candidate)
    ) {
      return;
    }
    seen.add(candidate);
    const code: unknown = Reflect.get(candidate, 'code');
    if (typeof code === 'string') codes.push(code);
    visit(Reflect.get(candidate, 'cause'), depth + 1);
    const nested: unknown = Reflect.get(candidate, 'errors');
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item, depth + 1);
    }
  };
  visit(error, 0);
  return codes;
}

/** Whether a database error means migrations have not run or the server is
 * unreachable, as opposed to a bug. Walks the `cause` chain because the query
 * layer wraps driver errors. */
export function isDatabaseNotReady(error: unknown): boolean {
  return errorCodes(error).some(
    (code) =>
      NOT_READY_PG_CODES.has(code) ||
      NOT_READY_NETWORK_CODES.has(code) ||
      code.startsWith('08'),
  );
}

/** Whether an error is a Postgres unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return errorCodes(error).includes('23505');
}
