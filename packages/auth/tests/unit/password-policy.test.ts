import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
} from '../../src/password-policy.js';

function captureError(candidate: unknown): unknown {
  try {
    Reflect.apply(assertPasswordPolicy, undefined, [candidate]);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Like `captureError`, but forwards a second `minLength` argument the way
 * a plain-JS caller could, even one outside the declared type. */
function captureErrorWithMinLength(
  candidate: unknown,
  minLength: unknown,
): unknown {
  try {
    Reflect.apply(assertPasswordPolicy, undefined, [candidate, minLength]);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('password policy', () => {
  it('sets the minimum length to 12', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
  });

  it('rejects a short password without echoing it in the message', () => {
    const error = captureError('short');
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(String(error)).not.toContain('short');
  });

  it('never reproduces a rejected secret in the error', () => {
    const candidate = 's3cr3t!';
    const error = captureError(candidate);
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(String(error)).not.toContain(candidate);
    expect(JSON.stringify(error)).not.toContain(candidate);
  });

  it('rejects one character below the minimum and accepts exactly the minimum', () => {
    expect(() => assertPasswordPolicy('a'.repeat(11))).toThrow(
      PasswordPolicyError,
    );
    expect(assertPasswordPolicy('a'.repeat(12))).toBeUndefined();
  });

  it('accepts twelve identical lowercase letters (no composition rule)', () => {
    expect(assertPasswordPolicy('aaaaaaaaaaaa')).toBeUndefined();
  });

  it('accepts a long passphrase', () => {
    expect(
      assertPasswordPolicy('Correct horse battery staple!'),
    ).toBeUndefined();
  });

  it('rejects the empty string', () => {
    expect(captureError('')).toBeInstanceOf(PasswordPolicyError);
  });

  it('rejects a non-string candidate', () => {
    expect(captureError(123456789012345)).toBeInstanceOf(PasswordPolicyError);
  });

  it('counts an astral-plane character once, not as two code units', () => {
    // 11 emoji = 22 UTF-16 code units but only 11 characters.
    expect(captureError('\u{1F600}'.repeat(11))).toBeInstanceOf(
      PasswordPolicyError,
    );
    expect(assertPasswordPolicy('\u{1F600}'.repeat(12))).toBeUndefined();
  });

  it('exposes the minimum length on the error', () => {
    const error = captureError('short');
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(error).toMatchObject({
      name: 'PasswordPolicyError',
      minLength: PASSWORD_MIN_LENGTH,
    });
  });
});

describe('a raised minimum', () => {
  it('rejects one character below a raised minimum and accepts exactly it', () => {
    const error = captureErrorWithMinLength('a'.repeat(15), 16);
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(error).toMatchObject({ minLength: 16 });
    expect(
      assertPasswordPolicy('a'.repeat(16), 16),
    ).toBeUndefined();
  });

  it('still counts a raised minimum in code points, not UTF-16 code units', () => {
    const error = captureErrorWithMinLength('\u{1F600}'.repeat(15), 16);
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(
      assertPasswordPolicy('\u{1F600}'.repeat(16), 16),
    ).toBeUndefined();
  });

  it('never enforces a minimum below the floor', () => {
    const error = captureErrorWithMinLength('a'.repeat(11), 8);
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(error).toMatchObject({ minLength: PASSWORD_MIN_LENGTH });
    expect(assertPasswordPolicy('a'.repeat(12), 8)).toBeUndefined();
  });

  it('throws TypeError for a non-integer minLength, not PasswordPolicyError', () => {
    for (const badMinLength of [12.5, Number.NaN, '16']) {
      const error = captureErrorWithMinLength('a'.repeat(32), badMinLength);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(PasswordPolicyError);
    }
  });

  it('throws TypeError for a non-integer minLength even for a short candidate', () => {
    const error = captureErrorWithMinLength('short', '16');
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(PasswordPolicyError);
  });
});
