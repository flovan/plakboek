/**
 * Public barrel for @plakboek/auth.
 *
 * Plan 02-02 added the tracer's exports (the first real better-auth wiring,
 * the first-user rule, the audited mutation path and the mail contract);
 * plan 02-10 owns the completed barrel once every plan in this phase has
 * shipped. Plans 02-03 through 02-09 run in parallel waves and MUST NOT
 * edit this file -- concurrent edits here would collide.
 */
export {
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
} from './password-policy.js';
export { createAuth, AuthConfigError } from './config.js';
export {
  createUserWithRole,
  SUPERADMIN_ROLE_KEY,
  FIRST_USER_LOCK_KEY,
} from './first-user.js';
export {
  runAuditedMutation,
  PermissionDeniedError,
  AuditWriteError,
} from './audit.js';
export { MailSendError } from './email/types.js';

export type { Auth, CreateAuthOptions } from './config.js';
export type {
  CreateUserInput,
  CreateUserOptions,
  CreateUserResult,
  UserCreationExecutor,
} from './first-user.js';
export type {
  AuditActor,
  AuditDatabase,
  AuditDeps,
  AuditEntryInput,
  AuditTransaction,
  AuditedMutation,
} from './audit.js';
export type { MailMessage, MailSender } from './email/types.js';
