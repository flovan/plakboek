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
