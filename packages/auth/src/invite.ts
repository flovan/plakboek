/**
 * Inviting a user and resending their set-password link (AUTH-02, AUTH-04).
 * Behaviour lands with the implementation; this skeleton only fixes the
 * exported surface the guard tests import.
 */
import type { AuditActor, AuditRecorder } from './audit.js';
import type { RenderAuthEmail } from './config.js';
import type { PasswordLinkRequestOutcome } from './credentials.js';
import type { MailSender } from './email/types.js';

export type InviteDeps = {
  readonly recorder: AuditRecorder;
  readonly mail: MailSender;
  readonly renderEmail?: RenderAuthEmail;
  readonly baseURL: string;
};

export type InviteUserInput = {
  readonly email: string;
  readonly name: string;
  readonly roleKey: string;
  readonly actor: AuditActor;
};

export type InviteUserResult = {
  readonly userId: string;
  readonly wasFirstUser: boolean;
};

export type ResendSetPasswordLinkInput = {
  readonly email: string;
  readonly actor: AuditActor;
};

export type InviteField = 'email' | 'name' | 'roleKey';

export class InvalidInviteError extends Error {
  readonly field: InviteField;

  constructor(field: InviteField) {
    super(`@plakboek/auth: invalid invite ${field}`);
    this.name = 'InvalidInviteError';
    this.field = field;
  }
}

export class InviteDeliveryError extends Error {
  readonly userId: string;
  readonly recipientDomain: string;

  constructor(userId: string, recipientDomain: string) {
    super('@plakboek/auth: not implemented');
    this.name = 'InviteDeliveryError';
    this.userId = userId;
    this.recipientDomain = recipientDomain;
  }
}

export function inviteUser(
  _deps: InviteDeps,
  _input: InviteUserInput,
): Promise<InviteUserResult> {
  return Promise.resolve({ userId: '', wasFirstUser: false });
}

export function resendSetPasswordLink(
  _deps: InviteDeps,
  _input: ResendSetPasswordLinkInput,
): Promise<PasswordLinkRequestOutcome> {
  return Promise.resolve({ delivered: true });
}
