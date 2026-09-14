/**
 * Single-use tokens for set-password, reset-password and magic-link links
 * (AUTH-03, AUTH-11, D-09).
 *
 * A token value is a bearer credential. It exists in three places only: the
 * return value of the issue call, the link sent to its owner, and the
 * argument of the consume call. It never reaches a log line, an error
 * message or an audit payload. Every other part of the system handles the
 * identifier stored in the database, never the value itself.
 *
 * Validity is strictly before `expiresAt`: at the instant of expiry a token
 * is already dead, so a 48-hour link is refused at the 48-hour mark.
 */
import { randomBytes } from 'node:crypto';

/** The purpose namespaces. Each purpose prefixes its stored identifiers, so
 * tokens of different purposes never match or invalidate each other. */
export const TOKEN_PURPOSES = Object.freeze([
  'set-password',
  'reset-password',
  'magic-link',
] as const);

export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

const MILLISECONDS_PER_SECOND = 1000;

/** Returns the matching member of `TOKEN_PURPOSES`, so a prefix is always
 * built from the constant and never from a caller's string. */
function knownPurpose(purpose: unknown): TokenPurpose {
  const known = TOKEN_PURPOSES.find((candidate) => candidate === purpose);
  if (known === undefined) {
    throw new TypeError(
      `@plakboek/auth: token purpose must be one of ${TOKEN_PURPOSES.join(', ')}`,
    );
  }
  return known;
}

/** The `verification.identifier` form of a token: `purpose:token`. */
export function tokenIdentifier(purpose: TokenPurpose, token: string): string {
  return `${knownPurpose(purpose)}:${token}`;
}

/** 256 bits from the operating system's cryptographic random source,
 * base64url-encoded: 43 URL-safe characters with no padding. */
export function generateTokenValue(): string {
  return randomBytes(32).toString('base64url');
}

/** The instant a token issued at `issuedAt` stops being valid. The window
 * arrives as a parameter (see `SET_PASSWORD_TOKEN_TTL_SECONDS` and
 * `MAGIC_LINK_TTL_SECONDS` in `config.ts`); this module restates no
 * lifetime. */
export function expiryFor(issuedAt: Date, ttlSeconds: number): Date {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError(
      '@plakboek/auth: a token lifetime must be a positive whole number of seconds',
    );
  }
  const expiresAt = new Date(
    issuedAt.getTime() + ttlSeconds * MILLISECONDS_PER_SECOND,
  );
  if (Number.isNaN(expiresAt.getTime())) {
    throw new RangeError(
      '@plakboek/auth: could not compute a token expiry from the issue instant',
    );
  }
  return expiresAt;
}

/** True only while `now` is strictly before `expiresAt`. An invalid instant
 * on either side compares false, so it is never usable. */
export function isTokenUsable(
  row: { readonly expiresAt: Date },
  now: Date,
): boolean {
  return now.getTime() < row.expiresAt.getTime();
}

/**
 * The one rejection for a token that never existed, was already consumed or
 * has expired. The three causes are deliberately indistinguishable: telling
 * them apart would tell an attacker which guessed or intercepted values were
 * once real. Carries the purpose only -- never the token value or the
 * subject it belonged to.
 */
export class InvalidOrExpiredTokenError extends Error {
  readonly purpose: TokenPurpose;

  constructor(purpose: TokenPurpose) {
    const known = knownPurpose(purpose);
    super(`@plakboek/auth: this ${known} link is invalid or has expired`);
    this.name = 'InvalidOrExpiredTokenError';
    this.purpose = known;
  }
}
