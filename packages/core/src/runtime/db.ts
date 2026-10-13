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

/** What is still running against one handle on nobody's request. */
type Background = {
  /** Aborted when the handle starts closing. */
  readonly closing: AbortController;
  readonly running: Set<Promise<void>>;
};

const BACKGROUND_KEY = Symbol.for('plakboek.db.background');

/** Held on `globalThis` beside the handle registry, so a re-evaluated module
 * still finds, and can stop, the work an earlier evaluation started. */
function backgrounds(): WeakMap<Db, Background> {
  const holder = globalThis as unknown as Record<
    symbol,
    WeakMap<Db, Background> | undefined
  >;
  let existing = holder[BACKGROUND_KEY];
  if (existing === undefined) {
    existing = new WeakMap();
    holder[BACKGROUND_KEY] = existing;
  }
  return existing;
}

function backgroundOf(handle: Db): Background {
  const all = backgrounds();
  let background = all.get(handle);
  if (background === undefined) {
    background = { closing: new AbortController(), running: new Set() };
    all.set(handle, background);
  }
  return background;
}

/**
 * Starts, without waiting for it, work that queries `handle` for the process
 * rather than for a request. `closeAllDbs` aborts the signal and waits for the
 * work to finish before it closes the handle: queries still queued in the
 * pool when it closes would open fresh connections after the close.
 *
 * `work` reports its own failures and should return soon after the signal is
 * aborted; a rejection is swallowed so it can never reach a request or crash
 * the process. Nothing starts on a handle that is already closing.
 */
export function runInBackground(
  handle: Db,
  work: (closing: AbortSignal) => Promise<void>,
): void {
  const background = backgroundOf(handle);
  if (background.closing.signal.aborted) return;
  const task: Promise<void> = work(background.closing.signal)
    .catch(() => undefined)
    .finally(() => {
      background.running.delete(task);
    });
  background.running.add(task);
}

/** Tells a handle's background work to stop and waits until it has. */
async function stopBackground(handle: Db): Promise<void> {
  const background = backgroundOf(handle);
  background.closing.abort();
  await Promise.all(background.running);
}

/**
 * Closes every pooled handle and forgets them (shutdown and tests). Each
 * handle's background work stops first, so nothing queries it, or reopens a
 * connection to it, once the pool is closed.
 */
export async function closeAllDbs(): Promise<void> {
  const handles = registry();
  const open = [...handles.values()];
  handles.clear();
  await Promise.all(
    open.map(async (handle) => {
      await stopBackground(handle);
      await handle.close();
    }),
  );
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
