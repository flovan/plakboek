import { describe, expect, it } from 'vitest';
import {
  TEST_EMAIL_TOKEN_TTL_MS,
  createSendLimiter,
  createTestEmailToken,
  verifyTestEmailToken,
} from '../../src/setup/token.js';

const secret = 'token-test-secret-0123456789-abcdefghijklmn';
const NOW = 1_800_000_000_000;

function issue(options: { homePublished?: boolean; now?: number } = {}) {
  return createTestEmailToken({
    secret,
    userId: 'user-1',
    homePublished: options.homePublished ?? true,
    now: options.now ?? NOW,
  });
}

describe('test-email token', () => {
  it('round-trips the user id and the published flag', () => {
    const token = issue();
    const verified = verifyTestEmailToken(token, { secret, now: NOW + 1000 });
    expect(verified).toMatchObject({ userId: 'user-1', homePublished: true });
    expect(typeof verified?.tokenId).toBe('string');

    const unpublished = verifyTestEmailToken(issue({ homePublished: false }), {
      secret,
      now: NOW,
    });
    expect(unpublished?.homePublished).toBe(false);
  });

  it('gives every token its own id', () => {
    const a = verifyTestEmailToken(issue(), { secret, now: NOW });
    const b = verifyTestEmailToken(issue(), { secret, now: NOW });
    expect(a?.tokenId).not.toBe(b?.tokenId);
  });

  it('rejects a token signed with another secret', () => {
    const forged = createTestEmailToken({
      secret: 'another-secret-0123456789-abcdefghijklmnopq',
      userId: 'user-1',
      homePublished: true,
      now: NOW,
    });
    expect(verifyTestEmailToken(forged, { secret, now: NOW })).toBeNull();
  });

  it('rejects a token with one changed character in the payload or the signature', () => {
    const token = issue();
    const [payload = '', signature = ''] = token.split('.');
    const flip = (value: string, at: number): string =>
      `${value.slice(0, at)}${value[at] === 'A' ? 'B' : 'A'}${value.slice(at + 1)}`;

    expect(
      verifyTestEmailToken(`${flip(payload, 5)}.${signature}`, {
        secret,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyTestEmailToken(`${payload}.${flip(signature, 10)}`, {
        secret,
        now: NOW,
      }),
    ).toBeNull();
    // The final character carries unused bits: it must still be rejected.
    expect(
      verifyTestEmailToken(
        `${payload}.${flip(signature, signature.length - 1)}`,
        { secret, now: NOW },
      ),
    ).toBeNull();
  });

  it('rejects malformed tokens', () => {
    for (const token of [
      '',
      'abc',
      '.',
      'a.b.c',
      `${'x'.repeat(5000)}.${'y'.repeat(43)}`,
      'eyJ1IjoxfQ.AAAA',
    ]) {
      expect(verifyTestEmailToken(token, { secret, now: NOW })).toBeNull();
    }
  });

  it('rejects a token past its 15 minutes and accepts one just inside', () => {
    expect(TEST_EMAIL_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    const token = issue();
    expect(
      verifyTestEmailToken(token, {
        secret,
        now: NOW + TEST_EMAIL_TOKEN_TTL_MS - 1,
      }),
    ).not.toBeNull();
    expect(
      verifyTestEmailToken(token, {
        secret,
        now: NOW + TEST_EMAIL_TOKEN_TTL_MS + 1,
      }),
    ).toBeNull();
  });
});

describe('send limiter', () => {
  it('allows five sends per token id and refuses the sixth', () => {
    const limiter = createSendLimiter({ max: 5 });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect([attempt, limiter.consume('token-a')]).toEqual([attempt, true]);
    }
    expect(limiter.consume('token-a')).toBe(false);
    expect(limiter.consume('token-a')).toBe(false);
  });

  it('counts each token id on its own', () => {
    const limiter = createSendLimiter({ max: 1 });
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
    expect(limiter.consume('b')).toBe(true);
  });

  it('never holds more token ids than configured', () => {
    const limiter = createSendLimiter({ max: 5, maxEntries: 3 });
    for (let id = 0; id < 50; id += 1) limiter.consume(`token-${String(id)}`);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
