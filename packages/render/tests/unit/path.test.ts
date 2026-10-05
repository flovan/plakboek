import { describe, expect, it } from 'vitest';
import {
  MAX_VISITOR_PATH_LENGTH,
  normalizeVisitorPath,
} from '../../src/path.js';

describe('normalizeVisitorPath', () => {
  it.each(['/', '/about-us', '/nl/over-ons', '/a/b-c/d1'])(
    'keeps the canonical path %s',
    (path) => {
      expect(normalizeVisitorPath(path)).toEqual({ kind: 'ok', path });
    },
  );

  it.each([
    ['/about-us/', '/about-us'],
    ['//about-us', '/about-us'],
    ['/nl//over-ons/', '/nl/over-ons'],
    ['/About-Us', '/about-us'],
    ['/NL/Over-Ons/', '/nl/over-ons'],
    ['///', '/'],
  ])('redirects %s to %s', (path, location) => {
    expect(normalizeVisitorPath(path)).toEqual({ kind: 'redirect', location });
  });

  it.each([
    '/wp-login.php',
    '/.env',
    '/a%20b',
    '/a_b',
    '/~x',
    '/caf%C3%A9',
    '//evil.example/x',
  ])('rejects %s as not found', (path) => {
    const result = normalizeVisitorPath(path);
    // `//evil.example/x` has a dot in its host part, so it is junk, never a
    // redirect to a protocol-relative location.
    expect(result).toEqual({ kind: 'not-found' });
  });

  it('rejects a path longer than the maximum', () => {
    const overlong = `/${'a'.repeat(MAX_VISITOR_PATH_LENGTH)}`;
    expect(normalizeVisitorPath(overlong)).toEqual({ kind: 'not-found' });
    const atLimit = `/${'a'.repeat(MAX_VISITOR_PATH_LENGTH - 1)}`;
    expect(normalizeVisitorPath(atLimit).kind).toBe('ok');
  });

  it('never produces a redirect location that is protocol-relative', () => {
    const inputs = [
      '//about-us',
      '///about-us//',
      '//Nl//Over-Ons/',
      '//',
      '////a',
    ];
    const locations = inputs.flatMap((input) => {
      const result = normalizeVisitorPath(input);
      return result.kind === 'redirect' ? [result.location] : [];
    });
    expect(locations).toHaveLength(inputs.length);
    expect(locations.every((value) => /^\/(?!\/)/.test(value))).toBe(true);
  });
});
