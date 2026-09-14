/**
 * The minimum password length (AUTH-06). D-08: the strength requirement is
 * length-only and NIST-aligned -- no composition rule (mandatory character
 * classes) and no expiry rule may ever be added here. This constant is the
 * single source the better-auth configuration reads for `minPasswordLength`,
 * and a later UI can surface it in copy without duplicating the number.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Thrown by `assertPasswordPolicy`. The message names the minimum length
 * only -- it never interpolates, logs or otherwise reproduces the rejected
 * candidate (T-02-01). `minLength` lets a caller build its own message
 * without re-deriving the number.
 */
export class PasswordPolicyError extends Error {
  readonly minLength: number;

  constructor(minLength: number) {
    super(
      `@plakboek/auth: password must be at least ${minLength} characters long`,
    );
    this.name = 'PasswordPolicyError';
    this.minLength = minLength;
  }
}

/**
 * Throws `PasswordPolicyError` when `candidate` is not a string or is
 * shorter than `PASSWORD_MIN_LENGTH`; returns otherwise. Length is counted in
 * code points (`Array.from`), so an astral-plane character such as an emoji
 * counts once rather than as two UTF-16 code units.
 */
export function assertPasswordPolicy(candidate: string): void {
  const isLongEnough =
    typeof candidate === 'string' &&
    Array.from(candidate).length >= PASSWORD_MIN_LENGTH;

  if (!isLongEnough) {
    throw new PasswordPolicyError(PASSWORD_MIN_LENGTH);
  }
}
