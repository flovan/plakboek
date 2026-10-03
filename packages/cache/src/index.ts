/**
 * Public barrel for @plakboek/cache.
 *
 * Named re-exports only, grouped by module, values and types in separate
 * statements, no wildcard and no default export. The package has no runtime
 * dependency: it imports no React, no `@plakboek/pages` and no database
 * driver.
 */

// tags
export {
  CACHE_TAG_PATTERN,
  contentTypeTag,
  GLOBAL_TAG,
  InvalidCacheTagError,
  isCacheTag,
  menuTag,
  pageTag,
} from './tags.js';

// backend
export type {
  CacheBackend,
  CacheEntry,
  CacheInvalidator,
  CacheSetOptions,
} from './backend.js';

// memory
export {
  createMemoryCache,
  DEFAULT_MEMORY_CACHE_MAX_BYTES,
  DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
  DEFAULT_MEMORY_CACHE_TTL_MS,
  MemoryCacheConfigError,
} from './memory.js';
export type { MemoryCacheOptions } from './memory.js';

// compose
export {
  CachePurgeError,
  composeInvalidators,
  purgePageTags,
} from './compose.js';
