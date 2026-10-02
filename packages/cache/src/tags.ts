/**
 * The cache tag vocabulary (D-19). A tag names a unit of invalidation: a
 * cached page carries every tag it depends on, and a write purges by tag.
 *
 * Tags are explicit at `set` time and collected by the renderer, never
 * derived from the cache key. `content-type:` and `menu:` are reserved now
 * for the phases that introduce those dependencies (19 and 15); only `page:`
 * and the bare `global` are used in Phase 5.
 *
 * The pattern is deliberately ASCII with no whitespace or commas, so the
 * same strings can later be emitted unchanged as CDN surrogate-key header
 * values.
 */

/** Purging this tag removes every entry, whatever tags it was stored with. */
export const GLOBAL_TAG = 'global';

/** Every well-formed cache tag: a lowercase kind, optionally `:` and a value. */
export const CACHE_TAG_PATTERN = /^[a-z][a-z-]*(?::[A-Za-z0-9._-]{1,128})?$/;

/** Thrown by a tag helper when its input would not form a valid tag. The
 * message names the helper and the rule, never the rejected value. */
export class InvalidCacheTagError extends Error {
  readonly helper: string;

  constructor(helper: string) {
    super(
      `[@plakboek/cache] ${helper} received a value that does not form a valid cache tag: 1 to 128 characters from A-Z, a-z, 0-9, ".", "_" and "-"`,
    );
    this.name = 'InvalidCacheTagError';
    this.helper = helper;
  }
}

/** Whether a value is a well-formed cache tag. */
export function isCacheTag(value: unknown): value is string {
  return typeof value === 'string' && CACHE_TAG_PATTERN.test(value);
}

function buildTag(helper: string, prefix: string, value: string): string {
  const tag = `${prefix}:${value}`;
  if (typeof value !== 'string' || !CACHE_TAG_PATTERN.test(tag)) {
    throw new InvalidCacheTagError(helper);
  }
  return tag;
}

/** `page:<id>`: everything rendered from one page. */
export function pageTag(pageId: string): string {
  return buildTag('pageTag', 'page', pageId);
}

/** `content-type:<key>`: everything that reads one content type. */
export function contentTypeTag(key: string): string {
  return buildTag('contentTypeTag', 'content-type', key);
}

/** `menu:<key>`: everything that renders one menu. */
export function menuTag(key: string): string {
  return buildTag('menuTag', 'menu', key);
}
