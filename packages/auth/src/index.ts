/**
 * Public barrel for @plakboek/auth, complete as of plan 02-10.
 *
 * Named re-exports only, grouped by module, values and types in separate
 * statements. `tests/unit/public-api.test.ts` holds this surface to one
 * literal list and to the README's Public API tables, so adding or removing
 * an export means changing all three together.
 *
 * Deliberately absent: the token value generator and identifier builder,
 * the expiry helpers, the advisory lock keys, the stored-address helper and
 * every schema table. A consumer that could reach them could write a
 * `verification`, `session` or `audit_log` row around the issue, consume and
 * audited paths this package guarantees.
 */
export {
  createAuth,
  AuthConfigError,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  IMPERSONATION_SESSION_TTL_SECONDS,
  SET_PASSWORD_TOKEN_TTL_SECONDS,
  MAGIC_LINK_TTL_SECONDS,
  TWO_FACTOR_CODE_TTL_SECONDS,
  TWO_FACTOR_LOCKOUT,
  DISABLED_AUTH_PATHS,
} from './config.js';
export type { Auth, CreateAuthOptions, RenderAuthEmail } from './config.js';

export {
  PASSWORD_MIN_LENGTH,
  assertPasswordPolicy,
  PasswordPolicyError,
} from './password-policy.js';

export { createUserWithRole, SUPERADMIN_ROLE_KEY } from './first-user.js';
export type {
  CreateUserInput,
  CreateUserOptions,
  CreateUserResult,
  UserCreationExecutor,
} from './first-user.js';

export {
  createAuditRecorder,
  runAuditedMutation,
  PermissionDeniedError,
  AuditWriteError,
} from './audit.js';
export type {
  AuditActor,
  AuditDatabase,
  AuditDeps,
  AuditEntryInput,
  AuditFailureHook,
  AuditRecorder,
  AuditTransaction,
  AuditWriteFailure,
  AuditedMutation,
} from './audit.js';

export {
  REDACTED_KEYS,
  REDACTION_MARKER,
  redactAuditPayload,
} from './audit-redaction.js';
export type { RedactAuditPayloadOptions } from './audit-redaction.js';

export { pruneAuditLog, AUDIT_RETENTION_DAYS } from './audit-prune.js';
export type { PruneAuditLogOptions } from './audit-prune.js';

export {
  consumeSingleUseToken,
  issueSingleUseToken,
  InvalidOrExpiredTokenError,
  TOKEN_PURPOSES,
} from './tokens.js';
export type {
  TokenPurpose,
  TokenDatabase,
  TokenTransaction,
  IssueSingleUseTokenInput,
  ConsumeSingleUseTokenInput,
  TokenClockOptions,
  AuthorizeWithToken,
} from './tokens.js';

export {
  requestPasswordLink,
  completeSetPassword,
  CredentialWriteError,
  PASSWORD_LINK_PATHS,
  CREDENTIAL_SET_ACTION,
} from './credentials.js';
export type {
  PasswordLinkPurpose,
  PasswordLinkRequestOutcome,
  PasswordLinkProbe,
  RequestPasswordLinkDeps,
  RequestPasswordLinkInput,
  CompleteSetPasswordDeps,
  CompleteSetPasswordInput,
} from './credentials.js';

export {
  inviteUser,
  resendSetPasswordLink,
  InviteDeliveryError,
  InvalidInviteError,
  InviteWriteError,
  USER_INVITE_ACTION,
  USER_RESEND_SET_PASSWORD_ACTION,
} from './invite.js';
export type {
  InviteDeps,
  InviteUserInput,
  InviteUserResult,
  ResendSetPasswordLinkInput,
  InviteField,
} from './invite.js';

export {
  startImpersonation,
  stopImpersonation,
  assertImpersonationTargetAllowed,
  auditActorFromSession,
  ImpersonationTargetForbiddenError,
  ImpersonationSessionError,
} from './impersonation.js';
export type {
  ImpersonatableSession,
  ImpersonationParty,
  ImpersonationRefusalReason,
  ImpersonationDeps,
  ImpersonationSessionResult,
  ImpersonationSessionRefusalReason,
} from './impersonation.js';

export {
  assertTwoFactorSatisfied,
  needsTwoFactorEnrolment,
  isTwoFactorRequiredForRole,
  TWO_FACTOR_REQUIRED_ROLE_KEYS,
  TWO_FACTOR_ENROLMENT_PATH,
  TwoFactorEnrolmentRequiredError,
} from './two-factor-gate.js';
export type { TwoFactorSubject } from './two-factor-gate.js';

export {
  createMailSender,
  createSmtpSender,
  createConsoleSender,
  MailSenderConfigError,
} from './email/sender.js';
export type {
  SmtpOptions,
  SmtpTransport,
  SmtpTransportConfig,
  SmtpTransportMessage,
  CreateSmtpTransport,
  CreateSmtpSenderOptions,
  CreateConsoleSenderOptions,
  CreateMailSenderOptions,
  MailSenderKind,
} from './email/sender.js';

export { renderAuthEmail, AUTH_EMAIL_KINDS } from './email/render.js';
export type { AuthEmailKind } from './email/render.js';

export { MailSendError } from './email/types.js';
export type { MailMessage, MailSender } from './email/types.js';
