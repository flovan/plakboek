import { describe, expect, it } from 'vitest';
import {
  InvalidSlugError,
  SLUG_MAX_LENGTH,
  SlugConflictError,
  SlugGenerationError,
  isNormalizedSlug,
  normalizeSlug,
} from '../../src/slug.js';

describe('normalizeSlug (TYPE-03)', () => {
  it('strips diacritics through NFKD decomposition, lowercases, and keeps Dutch "ij" as two letters', () => {
    expect(normalizeSlug('Één ëxample ïs IJsland')).toBe(
      'een-example-is-ijsland',
    );
  });

  it('collapses punctuation and whitespace runs into single hyphens and trims the ends', () => {
    expect(normalizeSlug('  --Hello,   World!--  ')).toBe('hello-world');
  });

  it('returns an empty string when nothing survives normalisation', () => {
    expect(normalizeSlug('!!!')).toBe('');
    expect(normalizeSlug('😀')).toBe('');
  });

  it('truncates to at most SLUG_MAX_LENGTH characters with no trailing hyphen', () => {
    // Pin the exact result, not just an upper bound. A bound alone stays
    // green if normalizeSlug truncates far more aggressively than it should.
    // 199 a's plus '-bcd' is 203, cut to 200 leaves a trailing hyphen, and
    // stripping it leaves exactly the 199 a's.
    const result = normalizeSlug(`${'a'.repeat(199)} bcd`);
    expect(result).toBe('a'.repeat(199));
    expect(result.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(result.endsWith('-')).toBe(false);
  });

  it('truncates to exactly SLUG_MAX_LENGTH when the cut lands mid-word', () => {
    // The boundary itself: a single run longer than the cap has no hyphen to
    // strip, so the result is the cap exactly.
    const result = normalizeSlug('b'.repeat(SLUG_MAX_LENGTH + 25));
    expect(result).toBe('b'.repeat(SLUG_MAX_LENGTH));
    expect(result.length).toBe(SLUG_MAX_LENGTH);
  });

  it('leaves a value of exactly SLUG_MAX_LENGTH untouched', () => {
    const exact = 'c'.repeat(SLUG_MAX_LENGTH);
    expect(normalizeSlug(exact)).toBe(exact);
  });
});

describe('isNormalizedSlug (TYPE-03/TYPE-04 encoding)', () => {
  it('accepts a normalized slug', () => {
    expect(isNormalizedSlug('news-2')).toBe(true);
  });

  it('rejects a capitalized slug, a double hyphen, a leading hyphen and an empty string', () => {
    expect(isNormalizedSlug('News')).toBe(false);
    expect(isNormalizedSlug('news--2')).toBe(false);
    expect(isNormalizedSlug('-news')).toBe(false);
    expect(isNormalizedSlug('')).toBe(false);
  });
});

describe('slug error classes', () => {
  it('SlugGenerationError names itself and carries no other public shape', () => {
    const error = new SlugGenerationError('!!!');
    expect(error.name).toBe('SlugGenerationError');
    expect(error).toBeInstanceOf(Error);
  });

  it('InvalidSlugError carries the normalized suggestion', () => {
    const error = new InvalidSlugError('News', 'news');
    expect(error.name).toBe('InvalidSlugError');
    expect(error.suggestion).toBe('news');
  });

  it('SlugConflictError carries slug, locale and contentTypeId', () => {
    const error = new SlugConflictError('hello', 'en', 'type-1');
    expect(error.name).toBe('SlugConflictError');
    expect(error.slug).toBe('hello');
    expect(error.locale).toBe('en');
    expect(error.contentTypeId).toBe('type-1');
  });
});
