import { describe, expect, it } from 'vitest';
import { matchesIfNoneMatch } from '../../src/conditional.js';

const ETAG = '"abc-DEF_123"';

describe('matchesIfNoneMatch', () => {
  it.each([null, '', '   '])(
    'does not match an absent header (%j)',
    (header) => {
      expect(matchesIfNoneMatch(header, ETAG)).toBe(false);
    },
  );

  it('matches `*`, with surrounding spaces', () => {
    expect(matchesIfNoneMatch('*', ETAG)).toBe(true);
    expect(matchesIfNoneMatch('  *  ', ETAG)).toBe(true);
  });

  it('matches the exact quoted tag', () => {
    expect(matchesIfNoneMatch(ETAG, ETAG)).toBe(true);
  });

  it('compares weakly: a W/ prefix is ignored on either side', () => {
    expect(matchesIfNoneMatch(`W/${ETAG}`, ETAG)).toBe(true);
    expect(matchesIfNoneMatch(ETAG, `W/${ETAG}`)).toBe(true);
    expect(matchesIfNoneMatch(`W/${ETAG}`, `W/${ETAG}`)).toBe(true);
  });

  it('finds the tag in a list with arbitrary spacing around the commas', () => {
    expect(matchesIfNoneMatch(`"a", ${ETAG}, "b"`, ETAG)).toBe(true);
    expect(matchesIfNoneMatch(`"a",${ETAG},"b"`, ETAG)).toBe(true);
    expect(matchesIfNoneMatch(`  "a"  ,   W/${ETAG}   ,"b"`, ETAG)).toBe(true);
    expect(matchesIfNoneMatch(`${ETAG} ,`, ETAG)).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(matchesIfNoneMatch('"other"', ETAG)).toBe(false);
    expect(matchesIfNoneMatch('"a", "b"', ETAG)).toBe(false);
    expect(matchesIfNoneMatch(`${ETAG}x`, ETAG)).toBe(false);
  });

  it('does not match an unquoted value or a malformed entry, and never throws', () => {
    expect(matchesIfNoneMatch('abc-DEF_123', ETAG)).toBe(false);
    expect(matchesIfNoneMatch('W/abc-DEF_123', ETAG)).toBe(false);
    expect(matchesIfNoneMatch('"', ETAG)).toBe(false);
    expect(matchesIfNoneMatch('W/', ETAG)).toBe(false);
    expect(matchesIfNoneMatch(',,,', ETAG)).toBe(false);
    expect(matchesIfNoneMatch('"unterminated', ETAG)).toBe(false);
  });

  it('does not treat `*` inside a list as a wildcard', () => {
    expect(matchesIfNoneMatch('"a", *', ETAG)).toBe(false);
  });

  it('evaluates a 10 000-character header without error', () => {
    const long = `${'"x",'.repeat(2_500)}${ETAG}`;
    expect(long.length).toBeGreaterThanOrEqual(10_000);
    expect(matchesIfNoneMatch(long, ETAG)).toBe(true);
    expect(matchesIfNoneMatch('a'.repeat(10_000), ETAG)).toBe(false);
    expect(matchesIfNoneMatch(','.repeat(10_000), ETAG)).toBe(false);
  });
});
