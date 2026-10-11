/**
 * What the login card decides without asking the server: whether a typed
 * value is worth sending, and which of the card's messages an auth answer
 * stands for. Pure functions over `STRINGS`, so they are tested without a
 * browser and the components stay free of rules.
 */
import { STRINGS } from '../../chrome/strings.js';

/** Where a wrong-code count stops being a retry and becomes the lockout step:
 * the server locks the account after this many consecutive wrong codes, and
 * the card counts the same ones. A test holds it equal to the auth package's
 * own setting. */
export const TWO_FACTOR_MAX_ATTEMPTS = 5;

/** The shortest password the auth package accepts. A password shorter than
 * this is not worth sending; an installation may require more, and the server
 * then refuses it. A test holds this equal to the auth package's own floor. */
export const PASSWORD_MIN_LENGTH = 12;

/** A code is six digits; an authenticator app shows them as `123 456`, so
 * spaces are not part of the code. */
const CODE_PATTERN = /^\d{6}$/;

/** Something before an `@`, something after it, and a dot in the domain. The
 * server is the judge of a real address; this only catches a typing slip. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** The text of an email field as it is sent: without surrounding spaces. */
export function normaliseEmail(value: string): string {
  return value.trim();
}

/** The text of a code field as it is sent: without any whitespace. */
export function normaliseCode(value: string): string {
  return value.replace(/\s+/g, '');
}

/** The inline message for an unusable email, or `null` when it is fine. */
export function validateEmail(value: string): string | null {
  const email = normaliseEmail(value);
  if (email === '') return STRINGS['validation.email.empty'];
  return EMAIL_PATTERN.test(email)
    ? null
    : STRINGS['validation.email.malformed'];
}

/** The inline message for an empty password, or `null`. A password is never
 * trimmed: spaces are legitimate characters of it. */
export function validatePassword(value: string): string | null {
  return value === '' ? STRINGS['validation.password.empty'] : null;
}

/** The inline message for a new password under the minimum, or `null`.
 * Length is counted in code points, as the server counts it. */
export function validateNewPassword(value: string): string | null {
  return Array.from(value).length >= PASSWORD_MIN_LENGTH
    ? null
    : STRINGS['validation.newPassword.tooShort'];
}

/** The inline message under the confirmation field when it differs from the
 * new password, or `null`. */
export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): string | null {
  return password === confirmation
    ? null
    : STRINGS['validation.confirm.mismatch'];
}

/** The inline message for a code that is not six digits, or `null`. */
export function validateCode(value: string): string | null {
  return CODE_PATTERN.test(normaliseCode(value))
    ? null
    : STRINGS['validation.code.invalid'];
}

/** What a failed auth call stands for in the card. */
export type AuthFailure =
  | 'credentials'
  /** The password typed to confirm a change was refused. */
  | 'password'
  | 'code'
  | 'lockout'
  | 'rate-limited'
  | 'network'
  | 'server';

/**
 * The better-auth error codes the card reacts to. They are the literal codes
 * of the installed library (`TWO_FACTOR_ERROR_CODES` and the base codes), held
 * here as text so this module imports nothing from it; a test compares every
 * one against the library itself.
 */
export const AUTH_ERROR_CODES = Object.freeze({
  wrongCredentials: 'INVALID_EMAIL_OR_PASSWORD',
  wrongPassword: 'INVALID_PASSWORD',
  invalidCode: 'INVALID_CODE',
  expiredCode: 'OTP_HAS_EXPIRED',
  accountLocked: 'ACCOUNT_TEMPORARILY_LOCKED',
  challengeSpent: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
  challengeGone: 'INVALID_TWO_FACTOR_COOKIE',
});

/**
 * The codes the password-link endpoints answer a refusal with. They are the
 * auth package's own literals, which it does not export, so they are held
 * here as text; the end-to-end link flows exercise both.
 */
export const LINK_ERROR_CODES = Object.freeze({
  invalidLink: 'INVALID_LINK',
  passwordTooShort: 'PASSWORD_TOO_SHORT',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Which failure an auth answer is. It accepts what the auth client reports
 * for a refused request (`{ status, code }`), a `Response`, or anything a
 * failed call threw. A request that never got an answer (a thrown error, or
 * no status at all) is a network failure, never a credentials one.
 *
 * Order matters: a locked account answers 429 like the rate limiter does, so
 * the lockout codes are read before the status.
 */
export function classifyAuthError(failure: unknown): AuthFailure {
  if (!isRecord(failure) || failure instanceof Error) return 'network';
  const code = typeof failure.code === 'string' ? failure.code : '';
  const status = typeof failure.status === 'number' ? failure.status : 0;
  if (
    code === AUTH_ERROR_CODES.accountLocked ||
    code === AUTH_ERROR_CODES.challengeSpent ||
    // The challenge a code is checked against lasts ten minutes; once it is
    // gone no code can work, and signing in again is the only way forward.
    code === AUTH_ERROR_CODES.challengeGone
  ) {
    return 'lockout';
  }
  if (status === 429) return 'rate-limited';
  if (code === AUTH_ERROR_CODES.wrongPassword) return 'password';
  if (
    code === AUTH_ERROR_CODES.invalidCode ||
    code === AUTH_ERROR_CODES.expiredCode
  ) {
    return 'code';
  }
  if (status === 0) return 'network';
  if (status >= 500) return 'server';
  if (status === 401 || code === AUTH_ERROR_CODES.wrongCredentials) {
    return 'credentials';
  }
  return 'server';
}

/** The error-box message of a failure that stays on its step. A lockout never
 * shows one (it moves to its own step); it reads as the server's if asked. */
export function failureMessage(failure: AuthFailure): string {
  switch (failure) {
    case 'credentials':
      return STRINGS['error.credentials'];
    case 'password':
      return STRINGS['error.passwordIncorrect'];
    case 'code':
      return STRINGS['error.code'];
    case 'rate-limited':
      return STRINGS['error.rateLimited'];
    case 'network':
      return STRINGS['error.network'];
    case 'lockout':
    case 'server':
      return STRINGS['error.server'];
  }
}

/**
 * An address for the "we emailed a code" line: its first character and its
 * domain, so the person can tell which mailbox without the card repeating the
 * whole address. `ada@example.com` becomes `a***@example.com`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  const first = Array.from(email.slice(0, at))[0] ?? '';
  return `${first}***${email.slice(at)}`;
}
