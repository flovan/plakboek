/**
 * The minimum password length (AUTH-06). D-08: the strength requirement is
 * length-only and NIST-aligned -- no composition rule (mandatory character
 * classes) and no expiry rule may ever be added here. This is the floor:
 * `createAuth`'s `minPasswordLength` may raise it for an installation, but
 * nothing may ever set the enforced minimum below it.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Thrown by `assertPasswordPolicy`. The message names the minimum length
 * only -- it never interpolates, logs or otherwise reproduces the rejected
 * candidate (T-02-01). `minLength` is the minimum that was enforced (the
 * floor, or a higher configured minimum), so a caller can build its own
 * message without re-deriving the number.
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
 * shorter than the enforced minimum; returns otherwise. Length is counted in
 * code points (`Array.from`), so an astral-plane character such as an emoji
 * counts once rather than as two UTF-16 code units.
 *
 * `minLength`, when supplied, raises the enforced minimum to
 * `Math.max(PASSWORD_MIN_LENGTH, minLength)` -- it can never lower it. It
 * must be an integer; a non-integer (including `NaN` or a numeric string
 * that slipped past the type system) throws `TypeError` before the
 * candidate is examined.
 */
export function assertPasswordPolicy(
  candidate: string,
  minLength?: number,
): void {
  if (minLength !== undefined && !Number.isInteger(minLength)) {
    throw new TypeError('@plakboek/auth: minLength must be an integer');
  }
  const enforcedMinLength = Math.max(
    PASSWORD_MIN_LENGTH,
    minLength ?? PASSWORD_MIN_LENGTH,
  );
  const isLongEnough =
    typeof candidate === 'string' &&
    Array.from(candidate).length >= enforcedMinLength;

  if (!isLongEnough) {
    throw new PasswordPolicyError(enforcedMinLength);
  }
}
