/**
 * Impersonation rules (D-11, D-12, D-13).
 *
 * This module is the only place the impersonation target rule lives, and the
 * only code that may call the admin plugin's impersonate API. No caller
 * reaches that API without passing through `startImpersonation`, which runs
 * this project's own target guard and the audited permission check first.
 *
 * The plugin's own gate is not what enforces D-13: its role vocabulary is
 * the plugin's, not this project's catalogue, and a guarantee that depends on
 * how that vocabulary happens to be configured is not a guarantee. The guard
 * here holds whatever the plugin is told.
 */
import type { AuditActor } from './audit.js';
import { SUPERADMIN_ROLE_KEY } from './first-user.js';

/** Why an impersonation target was refused. */
export type ImpersonationRefusalReason =
  | 'target-is-superadmin'
  | 'target-is-self';

/** Thrown when a target may not be impersonated. Carries the target's opaque
 * user id and the reason only -- never an address, display name or session
 * token. */
export class ImpersonationTargetForbiddenError extends Error {
  readonly targetUserId: string;
  readonly reason: ImpersonationRefusalReason;

  constructor(targetUserId: string, reason: ImpersonationRefusalReason) {
    super(
      `@plakboek/auth: impersonation of user "${targetUserId}" refused (${reason})`,
    );
    this.name = 'ImpersonationTargetForbiddenError';
    this.targetUserId = targetUserId;
    this.reason = reason;
  }
}

/** One side of an impersonation, as read from the user record. */
export type ImpersonationParty = {
  readonly userId: string;
  readonly roleKey: string;
};

/**
 * Returns when `actor` may impersonate `target`, and throws
 * `ImpersonationTargetForbiddenError` otherwise:
 *
 * - `target-is-self`: impersonating your own account, whatever its role.
 * - `target-is-superadmin`: D-13, a superadmin is never a target, so two
 *   equally privileged accounts can never blur into one audit trail.
 *
 * A target whose role key is unknown to the role map is allowed: an orphaned
 * role holds no permissions, so it is not a superadmin. Matching is exact.
 */
export function assertImpersonationTargetAllowed(
  target: ImpersonationParty,
  actor: ImpersonationParty,
): void {
  if (target.userId === actor.userId) {
    throw new ImpersonationTargetForbiddenError(
      target.userId,
      'target-is-self',
    );
  }
  if (target.roleKey === SUPERADMIN_ROLE_KEY) {
    throw new ImpersonationTargetForbiddenError(
      target.userId,
      'target-is-superadmin',
    );
  }
}

/** What an audit actor is derived from: the session's user id, that user's
 * stored role key, and the session's `impersonated_by` when set. */
export type ImpersonatableSession = {
  readonly userId: string;
  readonly roleKey: string;
  readonly impersonatedBy?: string;
};

/**
 * The audit actor for anything done while holding `session`. This is what
 * makes D-11's two-sided accountability hold: during an impersonation, the
 * impersonated user is recorded as the actor, because theirs are the
 * permissions being used, and the acting superadmin rides along in
 * `impersonator_user_id`, so the row names both people. Every call site
 * derives its actor here, so none can drop half of it.
 *
 * A session that claims to impersonate its own user is refused rather than
 * recorded with one identity in both columns.
 */
export function auditActorFromSession(
  session: ImpersonatableSession,
): AuditActor {
  if (session.impersonatedBy === undefined) {
    return { userId: session.userId, roleKey: session.roleKey };
  }
  if (session.impersonatedBy === session.userId) {
    throw new ImpersonationTargetForbiddenError(
      session.userId,
      'target-is-self',
    );
  }
  return {
    userId: session.userId,
    roleKey: session.roleKey,
    impersonatedBy: session.impersonatedBy,
  };
}
