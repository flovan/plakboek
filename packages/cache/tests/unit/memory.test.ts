import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '../../src/backend.js';
import {
  createMemoryCache,
  DEFAULT_MEMORY_CACHE_MAX_BYTES,
  DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
  DEFAULT_MEMORY_CACHE_TTL_MS,
  inspectMemoryCache,
  MemoryCacheConfigError,
} from '../../src/memory.js';
import { GLOBAL_TAG } from '../../src/tags.js';

function entry(size = 10, etag = 'etag'): CacheEntry {
  return {
    body: new Uint8Array(size),
    etag,
    contentLanguage: 'en',
    manifestHash: 'hash',
    buildId: null,
  };
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function put(
  cache: ReturnType<typeof createMemoryCache>,
  key: string,
  tags: readonly string[],
  value: CacheEntry = entry(),
): Promise<boolean> {
  const ticket = await cache.ticket();
  return await cache.set(key, value, { tags, ticket });
}

describe('defaults and configuration', () => {
  it('exports the documented defaults', () => {
    expect(DEFAULT_MEMORY_CACHE_MAX_ENTRIES).toBe(1000);
    expect(DEFAULT_MEMORY_CACHE_MAX_BYTES).toBe(67108864);
    expect(DEFAULT_MEMORY_CACHE_TTL_MS).toBe(600000);
  });

  it('collects every invalid option into one MemoryCacheConfigError', () => {
    const failure = thrownBy(() =>
      createMemoryCache({ maxEntries: 0, maxBytes: 1.5, ttlMs: -1 }),
    );
    expect(failure).toBeInstanceOf(MemoryCacheConfigError);
    expect((failure as MemoryCacheConfigError).name).toBe(
      'MemoryCacheConfigError',
    );
    expect((failure as MemoryCacheConfigError).issues).toHaveLength(3);
  });
});

describe('get / set / recency', () => {
  it('stores and returns an entry', async () => {
    const cache = createMemoryCache();
    expect(await put(cache, 'a', ['page:a'], entry(5, 'one'))).toBe(true);
    const hit = await cache.get('a');
    expect(hit?.etag).toBe('one');
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry, with a get refreshing recency', async () => {
    const cache = createMemoryCache({ maxEntries: 2 });
    await put(cache, 'a', ['page:a']);
    await put(cache, 'b', ['page:b']);
    await cache.get('a');
    await put(cache, 'c', ['page:c']);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();
  });

  it('overwriting a key replaces it without leaving index residue', async () => {
    const cache = createMemoryCache();
    await put(cache, 'a', ['page:one']);
    await put(cache, 'a', ['page:two']);
    expect(inspectMemoryCache(cache)).toMatchObject({
      entries: 1,
      indexedKeys: 1,
    });
    await cache.purge(['page:one']);
    expect(await cache.get('a')).toBeDefined();
    await cache.purge(['page:two']);
    expect(await cache.get('a')).toBeUndefined();
  });
});

describe('byte bound', () => {
  it('refuses an entry larger than maxBytes and stores nothing', async () => {
    const cache = createMemoryCache({ maxBytes: 100 });
    expect(await put(cache, 'big', ['page:a'], entry(101))).toBe(false);
    expect(await cache.get('big')).toBeUndefined();
    expect(inspectMemoryCache(cache).entries).toBe(0);
  });

  it('evicts least recently used entries until both bounds hold', async () => {
    const cache = createMemoryCache({ maxBytes: 100 });
    await put(cache, 'a', ['page:a'], entry(40));
    await put(cache, 'b', ['page:b'], entry(40));
    await put(cache, 'c', ['page:c'], entry(40));
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();
    expect(inspectMemoryCache(cache).bytes).toBe(80);

    await put(cache, 'd', ['page:d'], entry(90));
    const stats = inspectMemoryCache(cache);
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(90);
  });
});

describe('ttl', () => {
  it('treats an entry older than ttlMs as a miss and removes its index entries', async () => {
    let clock = 1_000;
    const cache = createMemoryCache({ ttlMs: 100, now: () => clock });
    await put(cache, 'a', ['page:a']);
    clock += 99;
    expect(await cache.get('a')).toBeDefined();
    clock += 2;
    expect(await cache.get('a')).toBeUndefined();
    expect(inspectMemoryCache(cache)).toEqual({
      entries: 0,
      bytes: 0,
      indexedKeys: 0,
      indexedTags: 0,
      stamps: 0,
    });
  });
});

describe('purge', () => {
  it('removes exactly the entries stored with the purged tag', async () => {
    const cache = createMemoryCache();
    await put(cache, 'a', ['page:a', 'menu:header']);
    await put(cache, 'b', ['page:b', 'menu:header']);
    await put(cache, 'c', ['page:c']);
    await cache.purge(['page:a']);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();
    await cache.purge(['menu:header']);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBeDefined();
  });

  it('purging global removes every entry whatever its tags', async () => {
    const cache = createMemoryCache();
    await put(cache, 'a', ['page:a']);
    await put(cache, 'b', []);
    await put(cache, 'c', ['content-type:news']);
    await cache.purge([GLOBAL_TAG]);
    expect(inspectMemoryCache(cache).entries).toBe(0);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBeUndefined();
  });

  it('purging an unknown tag is a no-op', async () => {
    const cache = createMemoryCache();
    await put(cache, 'a', ['page:a']);
    await cache.purge(['page:zzz']);
    expect(await cache.get('a')).toBeDefined();
  });
});

describe('ticketed fills (RESEARCH Pitfall 1)', () => {
  it('refuses a fill whose tag was purged after its ticket', async () => {
    const cache = createMemoryCache();
    const ticket = await cache.ticket();
    await cache.purge(['page:a']);
    expect(await cache.set('k', entry(), { tags: ['page:a'], ticket })).toBe(
      false,
    );
    expect(await cache.get('k')).toBeUndefined();
    expect(inspectMemoryCache(cache).entries).toBe(0);
  });

  it('accepts the same fill with a ticket taken after the purge', async () => {
    const cache = createMemoryCache();
    await cache.purge(['page:a']);
    const ticket = await cache.ticket();
    expect(await cache.set('k', entry(), { tags: ['page:a'], ticket })).toBe(
      true,
    );
    expect(await cache.get('k')).toBeDefined();
  });

  it('accepts a stale-ticket fill when only unrelated tags were purged', async () => {
    const cache = createMemoryCache();
    const ticket = await cache.ticket();
    await cache.purge(['page:other']);
    expect(await cache.set('k', entry(), { tags: ['page:a'], ticket })).toBe(
      true,
    );
  });

  it('refuses any fill when global was purged after its ticket', async () => {
    const cache = createMemoryCache();
    const ticket = await cache.ticket();
    await cache.purge([GLOBAL_TAG]);
    expect(await cache.set('k', entry(), { tags: ['page:a'], ticket })).toBe(
      false,
    );
    expect(await cache.set('k2', entry(), { tags: [], ticket })).toBe(false);
  });

  it('stays conservative once old purge stamps are forgotten', async () => {
    const cache = createMemoryCache();
    const early = await cache.ticket();
    for (let index = 0; index < 5000; index += 1) {
      await cache.purge([`page:p${index}`]);
    }
    expect(inspectMemoryCache(cache).stamps).toBeLessThanOrEqual(4096);
    // A ticket from before the forgotten stamps is refused for any tag.
    expect(
      await cache.set('k', entry(), {
        tags: ['page:never-purged'],
        ticket: early,
      }),
    ).toBe(false);
    // A fresh ticket still fills.
    expect(await put(cache, 'k', ['page:never-purged'])).toBe(true);
  });
});

describe('tag index consistency', () => {
  it('holds no key absent from the entry map after evictions, expiries and purges', async () => {
    let clock = 0;
    const cache = createMemoryCache({
      maxEntries: 3,
      ttlMs: 50,
      now: () => clock,
    });
    for (let index = 0; index < 10; index += 1) {
      await put(cache, `k${index}`, [`page:${index}`, 'menu:shared']);
      clock += 5;
    }
    expect(inspectMemoryCache(cache)).toMatchObject({
      entries: 3,
      indexedKeys: 3,
    });

    clock += 100;
    await cache.get('k9');
    expect(inspectMemoryCache(cache)).toMatchObject({
      entries: 2,
      indexedKeys: 2,
    });

    await put(cache, 'x', ['page:x']);
    await put(cache, 'y', ['page:y', 'menu:shared']);
    await cache.purge(['menu:shared']);
    const stats = inspectMemoryCache(cache);
    expect(stats.indexedKeys).toBe(stats.entries);
    await cache.purge([GLOBAL_TAG]);
    expect(inspectMemoryCache(cache)).toMatchObject({
      entries: 0,
      bytes: 0,
      indexedKeys: 0,
      indexedTags: 0,
    });
  });
});
