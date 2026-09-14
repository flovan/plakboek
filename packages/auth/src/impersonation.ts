// RED skeleton: the exports exist so the suite loads; the behaviour is not
// implemented yet.
import type { AuditActor } from './audit.js';

export type ImpersonationRefusalReason =
  | 'target-is-superadmin'
  | 'target-is-self';

export class ImpersonationTargetForbiddenError extends Error {
  readonly targetUserId: string = '';
  readonly reason: ImpersonationRefusalReason = 'target-is-self';
}

export type ImpersonationParty = {
  readonly userId: string;
  readonly roleKey: string;
};

export function assertImpersonationTargetAllowed(
  target: ImpersonationParty,
  actor: ImpersonationParty,
): void {
  void target;
  void actor;
}

export type ImpersonatableSession = {
  readonly userId: string;
  readonly roleKey: string;
  readonly impersonatedBy?: string;
};

export function auditActorFromSession(
  session: ImpersonatableSession,
): AuditActor {
  return { userId: session.impersonatedBy ?? '', roleKey: '' };
}
