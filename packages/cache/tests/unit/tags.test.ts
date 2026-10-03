import { describe, expect, it } from 'vitest';
import {
  CACHE_TAG_PATTERN,
  contentTypeTag,
  GLOBAL_TAG,
  InvalidCacheTagError,
  isCacheTag,
  menuTag,
  pageTag,
} from '../../src/tags.js';

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('tag helpers', () => {
  it('builds the three prefixed tags and the bare global tag', () => {
    expect(pageTag('6f1c0a52-aaaa-bbbb-cccc-123456789abc')).toBe(
      'page:6f1c0a52-aaaa-bbbb-cccc-123456789abc',
    );
    expect(contentTypeTag('news')).toBe('content-type:news');
    expect(menuTag('header')).toBe('menu:header');
    expect(GLOBAL_TAG).toBe('global');
  });

  it('matches every helper-built tag against the exported pattern', () => {
    for (const tag of [
      pageTag('abc'),
      contentTypeTag('blog-post'),
      menuTag('main_nav.v2'),
      GLOBAL_TAG,
    ]) {
      expect(CACHE_TAG_PATTERN.test(tag)).toBe(true);
    }
  });

  it('throws InvalidCacheTagError naming the helper for an invalid input', () => {
    expect(() => pageTag('')).toThrow(InvalidCacheTagError);
    expect(() => menuTag('has space')).toThrow(InvalidCacheTagError);
    expect(() => contentTypeTag('a,b')).toThrow(InvalidCacheTagError);

    const failure = thrownBy(() => menuTag('has space'));
    expect(failure).toBeInstanceOf(InvalidCacheTagError);
    expect((failure as InvalidCacheTagError).name).toBe('InvalidCacheTagError');
    expect((failure as InvalidCacheTagError).helper).toBe('menuTag');
    expect((failure as InvalidCacheTagError).message).toContain('menuTag');
  });

  it('never echoes a rejected value, however long', () => {
    const hostile = `x y ${'z'.repeat(300)}`;
    const message = (thrownBy(() => pageTag(hostile)) as Error).message;
    expect(message).not.toContain(hostile);
    expect(message).not.toContain('x y');
    expect(message.length).toBeLessThan(250);
  });

  it('rejects a value over 128 characters', () => {
    expect(() => pageTag('a'.repeat(129))).toThrow(InvalidCacheTagError);
    expect(pageTag('a'.repeat(128))).toBe(`page:${'a'.repeat(128)}`);
  });
});

describe('isCacheTag', () => {
  it('accepts well-formed tags', () => {
    expect(isCacheTag('page:abc')).toBe(true);
    expect(isCacheTag('global')).toBe(true);
    expect(isCacheTag('content-type:news')).toBe(true);
  });

  it('rejects malformed tags and non-strings', () => {
    expect(isCacheTag('Page:abc')).toBe(false);
    expect(isCacheTag('page:')).toBe(false);
    expect(isCacheTag('page:a b')).toBe(false);
    expect(isCacheTag('page:a,b')).toBe(false);
    expect(isCacheTag('')).toBe(false);
    expect(isCacheTag(42)).toBe(false);
    expect(isCacheTag(null)).toBe(false);
  });
});
