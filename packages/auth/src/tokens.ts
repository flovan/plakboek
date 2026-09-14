/**
 * Single-use tokens. Skeleton only: the behaviour lands with the
 * implementation commit.
 */
export const TOKEN_PURPOSES = Object.freeze([
  'set-password',
  'reset-password',
  'magic-link',
] as const);

export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export function tokenIdentifier(
  _purpose: TokenPurpose,
  _token: string,
): string {
  return '';
}

export function generateTokenValue(): string {
  return '';
}

export function expiryFor(issuedAt: Date, _ttlSeconds: number): Date {
  return issuedAt;
}

export function isTokenUsable(_row: { expiresAt: Date }, _now: Date): boolean {
  return true;
}

export class InvalidOrExpiredTokenError extends Error {
  readonly purpose: TokenPurpose;

  constructor(purpose: TokenPurpose) {
    super('');
    this.purpose = purpose;
  }
}
