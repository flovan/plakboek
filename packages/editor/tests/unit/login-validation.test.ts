import { TWO_FACTOR_LOCKOUT } from '@plakboek/auth';
import { BASE_ERROR_CODES } from 'better-auth';
import { TWO_FACTOR_ERROR_CODES } from 'better-auth/client/plugins';
import { describe, expect, it } from 'vitest';
import { STRINGS } from '../../src/chrome/strings.js';
import {
  AUTH_ERROR_CODES,
  CODE_FIELD_MAX_LENGTH,
  classifyAuthError,
  failureMessage,
  maskEmail,
  normaliseBackupCode,
  normaliseCode,
  normaliseEmail,
  TWO_FACTOR_MAX_ATTEMPTS,
  validateBackupCode,
  validateCode,
  validateEmail,
  validatePassword,
} from '../../src/client/login/validation.js';

describe('validateEmail', () => {
  it('asks for an address when there is none', () => {
    expect(validateEmail('')).toBe('Enter your email address.');
    expect(validateEmail('   ')).toBe('Enter your email address.');
  });

  it.each(['x@', 'x', '@example.com', 'a b@example.com', 'a@b', 'a@@b.c'])(
    'refuses %j as malformed',
    (value) => {
      expect(validateEmail(value)).toBe(
        'Enter an address like name@example.com.',
      );
    },
  );

  it.each(['ada@example.com', ' ada@example.com ', 'a.b+c@sub.example.co.uk'])(
    'accepts %j',
    (value) => {
      expect(validateEmail(value)).toBeNull();
    },
  );
});

describe('validatePassword', () => {
  it('asks for a password when there is none', () => {
    expect(validatePassword('')).toBe('Enter your password.');
  });

  it('accepts anything else, spaces included', () => {
    expect(validatePassword('x')).toBeNull();
    expect(validatePassword('   ')).toBeNull();
  });
});

describe('validateCode', () => {
  it.each(['', '12a456', '12345', '1234567', '12-456'])(
    'refuses %j',
    (value) => {
      expect(validateCode(value)).toBe('Enter the 6-digit code.');
    },
  );

  it.each(['123456', '000000', ' 123456 ', '123 456'])(
    'accepts %j',
    (value) => {
      expect(validateCode(value)).toBeNull();
    },
  );
});

describe('CODE_FIELD_MAX_LENGTH', () => {
  it('leaves room for the space an authenticator app shows in the middle', () => {
    expect('123 456'.length).toBeLessThanOrEqual(CODE_FIELD_MAX_LENGTH);
    expect(CODE_FIELD_MAX_LENGTH).toBeGreaterThan(6);
    // Whatever the field takes, once normalised, is still a valid code.
    expect(validateCode('123 456'.slice(0, CODE_FIELD_MAX_LENGTH))).toBeNull();
  });
});

describe('validateBackupCode', () => {
  it('asks for a code when there is none', () => {
    expect(validateBackupCode('')).toBe('Enter a backup code.');
    expect(validateBackupCode('  \n ')).toBe('Enter a backup code.');
  });

  it.each(['abcde-12345', ' abcde-12345 ', 'AbCdE12345'])(
    'accepts %j and leaves the format to the service',
    (value) => {
      expect(validateBackupCode(value)).toBeNull();
    },
  );

  it('strips whitespace but keeps the case', () => {
    expect(normaliseBackupCode(' aBcDe -12345\n')).toBe('aBcDe-12345');
  });
});

describe('what is sent', () => {
  it('trims an email and strips every space from a code', () => {
    expect(normaliseEmail('  ada@example.com ')).toBe('ada@example.com');
    expect(normaliseCode(' 123 456\n')).toBe('123456');
  });
});

describe('classifyAuthError', () => {
  it('reads wrong credentials as such, whatever the account', () => {
    expect(
      classifyAuthError({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }),
    ).toBe('credentials');
    expect(classifyAuthError({ status: 401 })).toBe('credentials');
  });

  it('reads an invalid or expired code as a wrong code', () => {
    expect(classifyAuthError({ status: 401, code: 'INVALID_CODE' })).toBe(
      'code',
    );
    expect(classifyAuthError({ status: 400, code: 'OTP_HAS_EXPIRED' })).toBe(
      'code',
    );
  });

  it('reads a locked account and a spent challenge as the lockout', () => {
    expect(
      classifyAuthError({ status: 429, code: 'ACCOUNT_TEMPORARILY_LOCKED' }),
    ).toBe('lockout');
    expect(
      classifyAuthError({
        status: 400,
        code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
      }),
    ).toBe('lockout');
    expect(
      classifyAuthError({ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' }),
    ).toBe('lockout');
  });

  it('reads a refused password confirmation as a wrong password, not as the server failing', () => {
    expect(classifyAuthError({ status: 400, code: 'INVALID_PASSWORD' })).toBe(
      'password',
    );
  });

  it('reads any other 429 as rate limiting', () => {
    expect(classifyAuthError({ status: 429 })).toBe('rate-limited');
    expect(classifyAuthError({ status: 429, code: 'RATE_LIMITED' })).toBe(
      'rate-limited',
    );
  });

  it('reads a thrown error or an answer with no status as a network failure', () => {
    expect(classifyAuthError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyAuthError({ message: 'offline' })).toBe('network');
    expect(classifyAuthError({ status: 0 })).toBe('network');
    expect(classifyAuthError(undefined)).toBe('network');
    expect(classifyAuthError('boom')).toBe('network');
  });

  it('reads a 5xx, and anything it does not know, as the server failing', () => {
    expect(classifyAuthError({ status: 500 })).toBe('server');
    expect(classifyAuthError({ status: 503, code: 'X' })).toBe('server');
    expect(classifyAuthError({ status: 403, code: 'INVALID_ORIGIN' })).toBe(
      'server',
    );
    expect(classifyAuthError({ status: 404 })).toBe('server');
  });

  it('classifies a fetch Response by its status', () => {
    expect(classifyAuthError(new Response(null, { status: 429 }))).toBe(
      'rate-limited',
    );
    expect(classifyAuthError(new Response(null, { status: 502 }))).toBe(
      'server',
    );
  });
});

describe('failureMessage', () => {
  it('says the same thing for any wrong sign-in, never which half was wrong', () => {
    expect(failureMessage('credentials')).toBe(
      'Email or password is incorrect. Check them and try again.',
    );
    expect(failureMessage('credentials')).not.toMatch(
      /\b(email|password) (is|was) (wrong|unknown)/i,
    );
  });

  it('has the UI-SPEC copy for every failure that stays on its step', () => {
    expect(failureMessage('code')).toBe(STRINGS['error.code']);
    expect(failureMessage('password')).toBe(STRINGS['error.passwordIncorrect']);
    expect(failureMessage('rate-limited')).toBe(STRINGS['error.rateLimited']);
    expect(failureMessage('network')).toBe(STRINGS['error.network']);
    expect(failureMessage('server')).toBe(STRINGS['error.server']);
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('ada@example.com')).toBe('a***@example.com');
  });

  it('keeps a whole first character that is outside the basic plane', () => {
    expect(maskEmail('\u{1d54f}x@example.com')).toBe(
      '\u{1d54f}***@example.com',
    );
  });

  it('leaves text that is not an address as it is', () => {
    expect(maskEmail('nobody')).toBe('nobody');
  });
});

describe('what the card repeats from the auth library', () => {
  it('uses the library error codes verbatim', () => {
    expect(AUTH_ERROR_CODES.wrongCredentials).toBe(
      BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD.code,
    );
    expect(AUTH_ERROR_CODES.invalidCode).toBe(
      TWO_FACTOR_ERROR_CODES.INVALID_CODE.code,
    );
    expect(AUTH_ERROR_CODES.invalidBackupCode).toBe(
      TWO_FACTOR_ERROR_CODES.INVALID_BACKUP_CODE.code,
    );
    expect(AUTH_ERROR_CODES.expiredCode).toBe(
      TWO_FACTOR_ERROR_CODES.OTP_HAS_EXPIRED.code,
    );
    expect(AUTH_ERROR_CODES.accountLocked).toBe(
      TWO_FACTOR_ERROR_CODES.ACCOUNT_TEMPORARILY_LOCKED.code,
    );
    expect(AUTH_ERROR_CODES.challengeSpent).toBe(
      TWO_FACTOR_ERROR_CODES.TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE.code,
    );
    expect(AUTH_ERROR_CODES.challengeGone).toBe(
      TWO_FACTOR_ERROR_CODES.INVALID_TWO_FACTOR_COOKIE.code,
    );
    expect(AUTH_ERROR_CODES.wrongPassword).toBe(
      BASE_ERROR_CODES.INVALID_PASSWORD.code,
    );
  });

  it('counts wrong codes the way the server locks the account', () => {
    expect(TWO_FACTOR_MAX_ATTEMPTS).toBe(TWO_FACTOR_LOCKOUT.maxFailedAttempts);
  });
});
