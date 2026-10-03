import {
  CACHE_TAG_PATTERN,
  contentTypeTag,
  createMemoryCache,
  DEFAULT_MEMORY_CACHE_MAX_BYTES,
  DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
  DEFAULT_MEMORY_CACHE_TTL_MS,
  GLOBAL_TAG,
  InvalidCacheTagError,
  isCacheTag,
  MemoryCacheConfigError,
  menuTag,
  pageTag,
  type CacheBackend,
  type CacheEntry,
  type CacheInvalidator,
  type CacheSetOptions,
  type MemoryCacheOptions,
} from '@plakboek/cache';

const failures: string[] = [];

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

expectEqual('pageTag', pageTag('abc'), 'page:abc');
expectEqual('contentTypeTag', contentTypeTag('news'), 'content-type:news');
expectEqual('menuTag', menuTag('header'), 'menu:header');
expectEqual('GLOBAL_TAG', GLOBAL_TAG, 'global');
expectEqual('isCacheTag', isCacheTag('page:abc'), true);
expectEqual('CACHE_TAG_PATTERN', CACHE_TAG_PATTERN.test('page:abc'), true);
expectEqual('default entries', DEFAULT_MEMORY_CACHE_MAX_ENTRIES, 1000);
expectEqual('default bytes', DEFAULT_MEMORY_CACHE_MAX_BYTES, 67108864);
expectEqual('default ttl', DEFAULT_MEMORY_CACHE_TTL_MS, 600000);

try {
  pageTag('');
  failures.push('pageTag("") did not throw');
} catch (error) {
  expectEqual(
    'InvalidCacheTagError',
    error instanceof InvalidCacheTagError,
    true,
  );
}

try {
  createMemoryCache({ maxEntries: 0 });
  failures.push('createMemoryCache({ maxEntries: 0 }) did not throw');
} catch (error) {
  expectEqual(
    'MemoryCacheConfigError',
    error instanceof MemoryCacheConfigError,
    true,
  );
}

const options: MemoryCacheOptions = { maxEntries: 10 };
const cache: CacheBackend = createMemoryCache(options);
const invalidator: CacheInvalidator = cache;
const entry: CacheEntry = {
  body: new Uint8Array([1, 2, 3]),
  etag: 'e',
  contentLanguage: 'en',
  manifestHash: 'h',
  buildId: null,
};

const ticket = await cache.ticket();
const setOptions: CacheSetOptions = { tags: [pageTag('abc')], ticket };
expectEqual('set', await cache.set('key', entry, setOptions), true);
expectEqual('get', (await cache.get('key'))?.etag, 'e');
await invalidator.purge([pageTag('abc')]);
expectEqual('get after purge', await cache.get('key'), undefined);
expectEqual(
  'stale fill refused',
  await cache.set('key', entry, setOptions),
  false,
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  'cache.ts: tags, the memory cache and the ticket rule behave from the packed package',
);
