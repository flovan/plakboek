# @plakboek/cache

Cache tags, the cache backend and invalidator contract, and a bounded
in-process cache for Plakboek CMS installations. The visitor request handler
in `@plakboek/render` reads and fills a `CacheBackend`; the page engine in
`@plakboek/pages` purges a `CacheInvalidator` after a write commits. This
package holds the contract both sides are written against, plus one
implementation. It has no runtime dependency.

## Install

```sh
pnpm add @plakboek/cache
```

## Status

The tag vocabulary, the backend contract and the bounded memory cache are
implemented and exported below. A shared backend (Redis, a CDN) is a later
implementation of the same `CacheBackend` shape.

## Ordering contract

Three rules keep a cache from serving stale content:

1. Take `ticket()` before reading any data you will cache.
2. `set` resolves `false` and stores nothing when any of its tags (or the
   `global` tag) was purged after that ticket was taken, so a fill that raced
   a purge is dropped instead of resurrecting stale content.
3. A purge runs after the writing transaction commits, never before.

## Process-local

`createMemoryCache` lives in one process. Two server processes behind a proxy
each hold their own cache and do not share purges, so a purge in one does not
reach the other until its entries expire (`ttlMs`, ten minutes by default).
Run a single process, or put a shared backend behind the same contract.

## Public API

Every export of `@plakboek/cache`, grouped the way `src/index.ts` groups
them. `tests/unit/public-api.test.ts` compares these tables with the entry
point, so an export cannot be added or removed without updating them.

### Tags

| Export                 | Kind     | Purpose                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------- |
| `GLOBAL_TAG`           | constant | `global`: purging it removes every entry                         |
| `CACHE_TAG_PATTERN`    | constant | The pattern every well-formed tag matches                        |
| `pageTag`              | function | Builds `page:<id>`                                               |
| `contentTypeTag`       | function | Builds `content-type:<key>`                                      |
| `menuTag`              | function | Builds `menu:<key>`                                              |
| `isCacheTag`           | function | Whether a value is a well-formed tag                             |
| `InvalidCacheTagError` | class    | Thrown by a tag helper when its input would not form a valid tag |

### Backend contract

| Export             | Kind | Purpose                                                             |
| ------------------ | ---- | ------------------------------------------------------------------- |
| `CacheEntry`       | type | One cached response: body, etag, language, manifest hash, build id  |
| `CacheSetOptions`  | type | The tags a fill depends on and the ticket taken before its read     |
| `CacheInvalidator` | type | The write side: `purge(tags)`                                       |
| `CacheBackend`     | type | An invalidator plus `ticket()`, `get(key)` and `set(key, entry, o)` |

### Memory cache

| Export                             | Kind     | Purpose                                                          |
| ---------------------------------- | -------- | ---------------------------------------------------------------- |
| `createMemoryCache`                | function | A bounded in-process LRU cache with a tag index and purge epochs |
| `MemoryCacheConfigError`           | class    | Thrown by `createMemoryCache` with every invalid option          |
| `DEFAULT_MEMORY_CACHE_MAX_ENTRIES` | constant | `1000`: the default entry-count bound                            |
| `DEFAULT_MEMORY_CACHE_MAX_BYTES`   | constant | `67108864` (64 MiB): the default byte bound                      |
| `DEFAULT_MEMORY_CACHE_TTL_MS`      | constant | `600000` (10 minutes): the backstop expiry                       |
| `MemoryCacheOptions`               | type     | Input to `createMemoryCache`: the bounds and an injectable clock |
