/**
 * The role-gated two-factor requirement (D-03, AUTH-07, AUTH-08).
 *
 * better-auth can enrol and challenge a second factor, but it has no notion
 * of "this role may do nothing until it has one". That rule lives here, as a
 * small deny-by-default predicate plus one asserting wrapper.
 *
 * Calling contract for the admin shell's route layer (Phase 7): a loader
 * guarding any protected route calls `assertTwoFactorSatisfied` with the
 * session's stored role key and two-factor enrolment flag before it renders
 * or loads anything else, and on `TwoFactorEnrolmentRequiredError` redirects
 * to `error.redirectTo`. Both inputs come from the session record (the user
 * row the session resolves to), never from a request header, query
 * parameter, form field or any other client-supplied hint.
 */
import { SUPERADMIN_ROLE_KEY } from './first-user.js';

/**
 * Roles that must have two-factor enabled before they can use any protected
 * route. D-03: two-factor is mandatory for superadmin and opt-in for every
 * other role. This is a login-time enforcement check kept in code, not a
 * per-role flag stored in the database, so changing it is a code change
 * that goes through review.
 */
export const TWO_FACTOR_REQUIRED_ROLE_KEYS: readonly string[] = Object.freeze([
  SUPERADMIN_ROLE_KEY,
]);

/** Where an unenrolled user who needs two-factor is sent. It sits under
 * `/cms`, which the admin shell reserves, so every caller routes to this one
 * string. */
export const TWO_FACTOR_ENROLMENT_PATH = '/cms/settings/2fa/enrol';

/** Snapshotted into a Set: `Set.has` never consults the prototype chain, so
 * a role key such as `__proto__` or `constructor` is absent rather than an
 * inherited member. */
const requiredRoleKeys: ReadonlySet<string> = new Set(
  TWO_FACTOR_REQUIRED_ROLE_KEYS,
);

/** What the gate decides from: both values read from the session record. */
export type TwoFactorSubject = {
  readonly roleKey: string;
  readonly twoFactorEnabled: boolean;
};

/** Thrown when a role that requires two-factor has not enrolled. Carries the
 * enrolment path and the role key only -- never the user's id, address or
 * display name. */
export class TwoFactorEnrolmentRequiredError extends Error {
  readonly redirectTo: string;
  readonly roleKey: string;

  constructor(roleKey: string) {
    super(
      `@plakboek/auth: role "${roleKey}" must enrol a second factor before continuing`,
    );
    this.name = 'TwoFactorEnrolmentRequiredError';
    this.redirectTo = TWO_FACTOR_ENROLMENT_PATH;
    this.roleKey = roleKey;
  }
}

/** Whether `roleKey` must have two-factor enabled. Matching is exact; an
 * unknown role key is not required and never throws. */
export function isTwoFactorRequiredForRole(roleKey: string): boolean {
  return requiredRoleKeys.has(roleKey);
}

/** Whether the subject must be sent to enrolment before anything else. */
export function needsTwoFactorEnrolment(subject: TwoFactorSubject): boolean {
  return (
    isTwoFactorRequiredForRole(subject.roleKey) && !subject.twoFactorEnabled
  );
}

/** Returns when the subject may proceed; throws
 * `TwoFactorEnrolmentRequiredError` when it must enrol first. */
export function assertTwoFactorSatisfied(subject: TwoFactorSubject): void {
  if (needsTwoFactorEnrolment(subject)) {
    throw new TwoFactorEnrolmentRequiredError(subject.roleKey);
  }
}
