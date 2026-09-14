import { describe, expect, it } from 'vitest';
import {
  MAGIC_LINK_TTL_SECONDS,
  SET_PASSWORD_TOKEN_TTL_SECONDS,
} from '../../src/config.js';
import {
  InvalidOrExpiredTokenError,
  TOKEN_PURPOSES,
  expiryFor,
  generateTokenValue,
  isTokenUsable,
  tokenIdentifier,
} from '../../src/tokens.js';

const EXPIRY = new Date('2026-09-16T12:00:00.000Z');

describe('token purposes', () => {
  it('fixes the three purpose namespaces in a frozen list', () => {
    expect([...TOKEN_PURPOSES]).toEqual([
      'set-password',
      'reset-password',
      'magic-link',
    ]);
    expect(Object.isFrozen(TOKEN_PURPOSES)).toBe(true);
  });

  it('builds the stored identifier as purpose:token', () => {
    expect(tokenIdentifier('set-password', 'abc')).toBe('set-password:abc');
    expect(tokenIdentifier('reset-password', 'abc')).toBe('reset-password:abc');
    expect(tokenIdentifier('magic-link', 'abc')).toBe('magic-link:abc');
  });

  it('refuses a purpose that is not in the list, so no caller string reaches the prefix', () => {
    for (const purpose of ['admin', 'set-password%', '%', '', 'SET-PASSWORD']) {
      expect(() =>
        Reflect.apply(tokenIdentifier, undefined, [purpose, 'abc']),
      ).toThrow(TypeError);
    }
  });
});

describe('token expiry arithmetic (AUTH-03)', () => {
  it('rejects a token at the exact instant of expiry', () => {
    expect(
      isTokenUsable({ expiresAt: EXPIRY }, new Date(EXPIRY.getTime())),
    ).toBe(false);
  });

  it('accepts a token one millisecond before its expiry instant', () => {
    expect(
      isTokenUsable({ expiresAt: EXPIRY }, new Date(EXPIRY.getTime() - 1)),
    ).toBe(true);
  });

  it('rejects a token one millisecond after its expiry instant', () => {
    expect(
      isTokenUsable({ expiresAt: EXPIRY }, new Date(EXPIRY.getTime() + 1)),
    ).toBe(false);
  });

  it('treats an invalid instant on either side as not usable', () => {
    const invalid = new Date(Number.NaN);
    expect(isTokenUsable({ expiresAt: invalid }, EXPIRY)).toBe(false);
    expect(isTokenUsable({ expiresAt: EXPIRY }, invalid)).toBe(false);
  });

  it('puts the set-password expiry exactly 48 hours after issue', () => {
    const issuedAt = new Date('2026-09-14T08:30:15.123Z');
    expect(
      expiryFor(issuedAt, SET_PASSWORD_TOKEN_TTL_SECONDS).getTime() -
        issuedAt.getTime(),
    ).toBe(172800000);
  });

  it('puts the magic-link expiry exactly 15 minutes after issue', () => {
    const issuedAt = new Date('2026-09-14T08:30:15.123Z');
    expect(
      expiryFor(issuedAt, MAGIC_LINK_TTL_SECONDS).getTime() -
        issuedAt.getTime(),
    ).toBe(900000);
  });

  it('refuses a window that is not a positive whole number of seconds, or an invalid issue instant', () => {
    const issuedAt = new Date('2026-09-14T08:30:15.123Z');
    for (const ttlSeconds of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => expiryFor(issuedAt, ttlSeconds)).toThrow(RangeError);
    }
    expect(() => expiryFor(new Date(Number.NaN), 60)).toThrow(RangeError);
  });
});

describe('token values', () => {
  it('encodes 256 random bits as an unpadded URL-safe string', () => {
    const value = generateTokenValue();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  });

  it('never returns the same value twice', () => {
    const values = new Set(Array.from({ length: 64 }, generateTokenValue));
    expect(values.size).toBe(64);
  });
});

describe('InvalidOrExpiredTokenError (T-02-35, T-02-36)', () => {
  it('names the purpose, carries it as a field and uses the package prefix', () => {
    const error = new InvalidOrExpiredTokenError('reset-password');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidOrExpiredTokenError');
    expect(error.purpose).toBe('reset-password');
    expect(error.message.startsWith('@plakboek/auth: ')).toBe(true);
    expect(error.message).toContain('reset-password');
  });

  it('contains neither a token value nor a subject id, even when handed them', () => {
    const token = generateTokenValue();
    const subjectId = 'subject-5b1e0c2a-5d4b-4f7e-9a51-0d1c3f2b7e11';
    const error: unknown = Reflect.construct(InvalidOrExpiredTokenError, [
      'set-password',
      token,
      subjectId,
    ]);
    const rendered = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(
      Object.getOwnPropertyDescriptors(error),
    )}`;
    expect(rendered).toContain('set-password');
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(subjectId);
  });
});
