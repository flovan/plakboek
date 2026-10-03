/**
 * A bounded in-process cache (D-17, D-18).
 *
 * Bounds: entry count AND bytes (`body.byteLength`), least recently used
 * evicted first, with a TTL backstop for a host that wires a cache into its
 * handler but forgets the invalidator.
 *
 * Purge epochs: one monotonic counter, and one `tag -> epoch` stamp per
 * purged tag. `ticket()` returns the current epoch; `set` refuses a fill
 * when `global` or any of its tags carries a stamp newer than the ticket.
 * The stamp map is bounded too: once it overflows, the oldest stamps are
 * forgotten and a floor epoch is raised past them, so a ticket older than
 * a forgotten stamp is refused for every tag. That errs towards refusing a
 * fill, never towards serving stale content.
 *
 * Every removal (eviction, expiry, purge, overwrite) runs through one private
 * function that also cleans the tag index, so no path can orphan an index
 * entry.
 *
 * The cache is per process: two processes behind a proxy do not share purges.
 */
import type { CacheBackend, CacheEntry, CacheSetOptions } from './backend.js';
import { GLOBAL_TAG } from './tags.js';

export const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 1000;
/** 64 MiB, measured as the sum of `entry.body.byteLength`. */
export const DEFAULT_MEMORY_CACHE_MAX_BYTES = 67108864;
/** 10 minutes: the backstop when nothing ever purges. */
export const DEFAULT_MEMORY_CACHE_TTL_MS = 600000;

/** How many purge stamps are remembered before the oldest are forgotten. */
const MAX_PURGE_STAMPS = 4096;

export type MemoryCacheOptions = {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly ttlMs?: number;
  /** Clock in milliseconds; injectable for tests. */
  readonly now?: () => number;
};

/** Thrown by `createMemoryCache` with every invalid option, collected. */
export class MemoryCacheConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      ['[@plakboek/cache] invalid memory cache options:', ...issues].join('\n'),
    );
    this.name = 'MemoryCacheConfigError';
    this.issues = issues;
  }
}

type Stored = {
  readonly entry: CacheEntry;
  readonly tags: readonly string[];
  readonly bytes: number;
  readonly expiresAt: number;
};

type Inspection = {
  readonly entries: number;
  readonly bytes: number;
  readonly indexedKeys: number;
  readonly indexedTags: number;
  readonly stamps: number;
};

const inspectors = new WeakMap<object, () => Inspection>();

/**
 * A size probe over a cache `createMemoryCache` returned, for tests that
 * prove the tag index never outlives its entries. Not part of the package's
 * public entry point.
 */
export function inspectMemoryCache(cache: CacheBackend): Inspection {
  const inspect = inspectors.get(cache);
  if (inspect === undefined) {
    throw new TypeError('not a cache created by createMemoryCache');
  }
  return inspect();
}

function checkPositiveInteger(
  issues: string[],
  name: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${name} must be a positive integer`);
    return undefined;
  }
  return value;
}

export function createMemoryCache(
  options: MemoryCacheOptions = {},
): CacheBackend {
  const issues: string[] = [];
  const maxEntries = checkPositiveInteger(
    issues,
    'maxEntries',
    options.maxEntries,
  );
  const maxBytes = checkPositiveInteger(issues, 'maxBytes', options.maxBytes);
  const ttlMs = checkPositiveInteger(issues, 'ttlMs', options.ttlMs);
  if (issues.length > 0) {
    throw new MemoryCacheConfigError(issues);
  }
  const entryLimit = maxEntries ?? DEFAULT_MEMORY_CACHE_MAX_ENTRIES;
  const byteLimit = maxBytes ?? DEFAULT_MEMORY_CACHE_MAX_BYTES;
  const ttl = ttlMs ?? DEFAULT_MEMORY_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  // Insertion order is recency order: oldest first.
  const entries = new Map<string, Stored>();
  const tagIndex = new Map<string, Set<string>>();
  const stamps = new Map<string, number>();
  let totalBytes = 0;
  let epoch = 0;
  // Purge stamps at or below this epoch have been forgotten.
  let forgottenUpTo = 0;

  function remove(key: string): void {
    const stored = entries.get(key);
    if (stored === undefined) return;
    entries.delete(key);
    totalBytes -= stored.bytes;
    for (const tag of stored.tags) {
      const keys = tagIndex.get(tag);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) tagIndex.delete(tag);
    }
  }

  function stamp(tag: string): void {
    stamps.delete(tag);
    stamps.set(tag, epoch);
    while (stamps.size > MAX_PURGE_STAMPS) {
      const oldest = stamps.entries().next();
      if (oldest.done) break;
      const [oldestTag, oldestEpoch] = oldest.value;
      stamps.delete(oldestTag);
      forgottenUpTo = Math.max(forgottenUpTo, oldestEpoch);
    }
  }

  function purgedAfter(tag: string, ticket: number): boolean {
    const stamped = stamps.get(tag);
    return stamped !== undefined && stamped > ticket;
  }

  const cache: CacheBackend = {
    ticket(): Promise<number> {
      return Promise.resolve(epoch);
    },

    get(key: string): Promise<CacheEntry | undefined> {
      const stored = entries.get(key);
      if (stored === undefined) return Promise.resolve(undefined);
      if (stored.expiresAt <= now()) {
        remove(key);
        return Promise.resolve(undefined);
      }
      entries.delete(key);
      entries.set(key, stored);
      return Promise.resolve(stored.entry);
    },

    set(
      key: string,
      entry: CacheEntry,
      setOptions: CacheSetOptions,
    ): Promise<boolean> {
      const bytes = entry.body.byteLength;
      if (bytes > byteLimit) return Promise.resolve(false);
      const { ticket } = setOptions;
      if (forgottenUpTo > ticket || purgedAfter(GLOBAL_TAG, ticket)) {
        return Promise.resolve(false);
      }
      for (const tag of setOptions.tags) {
        if (purgedAfter(tag, ticket)) return Promise.resolve(false);
      }

      remove(key);
      const tags = [...new Set(setOptions.tags)];
      entries.set(key, { entry, tags, bytes, expiresAt: now() + ttl });
      totalBytes += bytes;
      for (const tag of tags) {
        const keys = tagIndex.get(tag);
        if (keys === undefined) {
          tagIndex.set(tag, new Set([key]));
        } else {
          keys.add(key);
        }
      }

      while (entries.size > entryLimit || totalBytes > byteLimit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        remove(oldest.value);
      }
      return Promise.resolve(true);
    },

    purge(tags: readonly string[]): Promise<void> {
      epoch += 1;
      for (const tag of tags) {
        stamp(tag);
        if (tag === GLOBAL_TAG) {
          for (const key of entries.keys()) remove(key);
          continue;
        }
        const keys = tagIndex.get(tag);
        if (keys === undefined) continue;
        for (const key of keys) remove(key);
      }
      return Promise.resolve();
    },
  };

  inspectors.set(cache, () => {
    const indexed = new Set<string>();
    for (const keys of tagIndex.values()) {
      for (const key of keys) indexed.add(key);
    }
    return {
      entries: entries.size,
      bytes: totalBytes,
      indexedKeys: indexed.size,
      indexedTags: tagIndex.size,
      stamps: stamps.size,
    };
  });
  return cache;
}
