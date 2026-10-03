/**
 * The cache backend and invalidator contract (D-17). Every later cache layer
 * and every purge caller is written against these types, so every method is
 * async: a shared backend (Redis, a CDN) implements the same shape later
 * without a signature change.
 *
 * Ordering contract, in prose because a type cannot carry it:
 *
 * - Take `ticket()` BEFORE reading any data you will cache. The ticket marks
 *   the moment your read began.
 * - `set` resolves `false` and stores nothing when any of its tags (or
 *   `global`) was purged after that ticket was taken. A fill that raced a
 *   purge is therefore dropped instead of resurrecting stale content.
 * - A purge runs after the writing transaction commits (D-18), never before:
 *   purging first lets a concurrent reader re-fill the old content.
 */

/** One cached response: the body and the headers derived from it. */
export type CacheEntry = {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly contentLanguage: string;
  readonly manifestHash: string;
  readonly buildId: string | null;
};

/** What a fill declares about itself. */
export type CacheSetOptions = {
  /** Every tag this entry depends on; a purge of any of them removes it. */
  readonly tags: readonly string[];
  /** The value `ticket()` returned before the data was read. */
  readonly ticket: number;
};

/** The write side every purge caller depends on: invalidate by tag. */
export type CacheInvalidator = {
  /** Removes every entry stored with any of the given tags. Purging the
   * `global` tag removes every entry. */
  purge(tags: readonly string[]): Promise<void>;
};

/** A cache a request handler reads and fills, and a writer purges. */
export type CacheBackend = CacheInvalidator & {
  /** A marker to take before reading data you intend to cache. */
  ticket(): Promise<number>;
  /** The live entry for a key, or `undefined`. */
  get(key: string): Promise<CacheEntry | undefined>;
  /** Stores an entry. Resolves `true` when stored; `false` when refused
   * because a tag was purged after the ticket, or the entry is oversize. */
  set(
    key: string,
    entry: CacheEntry,
    options: CacheSetOptions,
  ): Promise<boolean>;
};
