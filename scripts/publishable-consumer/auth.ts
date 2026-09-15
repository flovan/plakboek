import {
  AUDIT_RETENTION_DAYS,
  AUTH_EMAIL_KINDS,
  AuditWriteError,
  AuthConfigError,
  CREDENTIAL_SET_ACTION,
  CredentialWriteError,
  DISABLED_AUTH_PATHS,
  IMPERSONATION_SESSION_TTL_SECONDS,
  ImpersonationSessionError,
  ImpersonationTargetForbiddenError,
  InvalidInviteError,
  InvalidOrExpiredTokenError,
  InviteDeliveryError,
  InviteWriteError,
  MAGIC_LINK_TTL_SECONDS,
  MailSendError,
  MailSenderConfigError,
  PASSWORD_LINK_PATHS,
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  PermissionDeniedError,
  REDACTED_KEYS,
  REDACTION_MARKER,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  SET_PASSWORD_TOKEN_TTL_SECONDS,
  SUPERADMIN_ROLE_KEY,
  TOKEN_PURPOSES,
  TWO_FACTOR_CODE_TTL_SECONDS,
  TWO_FACTOR_ENROLMENT_PATH,
  TWO_FACTOR_LOCKOUT,
  TWO_FACTOR_REQUIRED_ROLE_KEYS,
  TwoFactorEnrolmentRequiredError,
  USER_INVITE_ACTION,
  USER_RESEND_SET_PASSWORD_ACTION,
  assertImpersonationTargetAllowed,
  assertPasswordPolicy,
  assertTwoFactorSatisfied,
  auditActorFromSession,
  completeSetPassword,
  consumeSingleUseToken,
  createAuditRecorder,
  createAuth,
  createConsoleSender,
  createMailSender,
  createSmtpSender,
  createUserWithRole,
  inviteUser,
  isTwoFactorRequiredForRole,
  issueSingleUseToken,
  needsTwoFactorEnrolment,
  pruneAuditLog,
  redactAuditPayload,
  renderAuthEmail,
  requestPasswordLink,
  resendSetPasswordLink,
  runAuditedMutation,
  startImpersonation,
  stopImpersonation,
  type AuditActor,
  type AuditDatabase,
  type AuditDeps,
  type AuditEntryInput,
  type AuditFailureHook,
  type AuditRecorder,
  type AuditTransaction,
  type AuditWriteFailure,
  type AuditedMutation,
  type Auth,
  type AuthEmailKind,
  type AuthorizeWithToken,
  type CompleteSetPasswordDeps,
  type CompleteSetPasswordInput,
  type ConsumeSingleUseTokenInput,
  type CreateAuthOptions,
  type CreateConsoleSenderOptions,
  type CreateMailSenderOptions,
  type CreateSmtpSenderOptions,
  type CreateSmtpTransport,
  type CreateUserInput,
  type CreateUserOptions,
  type CreateUserResult,
  type ImpersonatableSession,
  type ImpersonationDeps,
  type ImpersonationParty,
  type ImpersonationRefusalReason,
  type ImpersonationSessionRefusalReason,
  type ImpersonationSessionResult,
  type InviteDeps,
  type InviteField,
  type InviteUserInput,
  type InviteUserResult,
  type IssueSingleUseTokenInput,
  type MailMessage,
  type MailSender,
  type MailSenderKind,
  type PasswordLinkProbe,
  type PasswordLinkPurpose,
  type PasswordLinkRequestOutcome,
  type PruneAuditLogOptions,
  type RedactAuditPayloadOptions,
  type RenderAuthEmail,
  type RequestPasswordLinkDeps,
  type RequestPasswordLinkInput,
  type ResendSetPasswordLinkInput,
  type SmtpOptions,
  type SmtpTransport,
  type SmtpTransportConfig,
  type SmtpTransportMessage,
  type TokenClockOptions,
  type TokenDatabase,
  type TokenPurpose,
  type TokenTransaction,
  type TwoFactorSubject,
  type UserCreationExecutor,
} from '@plakboek/auth';
import * as auth from '@plakboek/auth';

// Runtime kind checks. Nothing below is called except `redactAuditPayload`,
// `renderAuthEmail` and the policy predicates, which are pure: no
// connection is opened and no message is sent.

const functions: Record<string, unknown> = {
  assertImpersonationTargetAllowed,
  assertPasswordPolicy,
  assertTwoFactorSatisfied,
  auditActorFromSession,
  completeSetPassword,
  consumeSingleUseToken,
  createAuditRecorder,
  createAuth,
  createConsoleSender,
  createMailSender,
  createSmtpSender,
  createUserWithRole,
  inviteUser,
  isTwoFactorRequiredForRole,
  issueSingleUseToken,
  needsTwoFactorEnrolment,
  pruneAuditLog,
  redactAuditPayload,
  renderAuthEmail,
  requestPasswordLink,
  resendSetPasswordLink,
  runAuditedMutation,
  startImpersonation,
  stopImpersonation,
};

const errorClasses: Record<string, unknown> = {
  AuditWriteError,
  AuthConfigError,
  CredentialWriteError,
  ImpersonationSessionError,
  ImpersonationTargetForbiddenError,
  InvalidInviteError,
  InvalidOrExpiredTokenError,
  InviteDeliveryError,
  InviteWriteError,
  MailSendError,
  MailSenderConfigError,
  PasswordPolicyError,
  PermissionDeniedError,
  TwoFactorEnrolmentRequiredError,
};

const numbers: Record<string, unknown> = {
  AUDIT_RETENTION_DAYS,
  IMPERSONATION_SESSION_TTL_SECONDS,
  MAGIC_LINK_TTL_SECONDS,
  PASSWORD_MIN_LENGTH,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  SET_PASSWORD_TOKEN_TTL_SECONDS,
  TWO_FACTOR_CODE_TTL_SECONDS,
};

const strings: Record<string, unknown> = {
  CREDENTIAL_SET_ACTION,
  REDACTION_MARKER,
  SUPERADMIN_ROLE_KEY,
  TWO_FACTOR_ENROLMENT_PATH,
  USER_INVITE_ACTION,
  USER_RESEND_SET_PASSWORD_ACTION,
};

const frozenArrays: Record<string, unknown> = {
  AUTH_EMAIL_KINDS,
  DISABLED_AUTH_PATHS,
  REDACTED_KEYS,
  TOKEN_PURPOSES,
  TWO_FACTOR_REQUIRED_ROLE_KEYS,
};

const frozenObjects: Record<string, unknown> = {
  PASSWORD_LINK_PATHS,
  TWO_FACTOR_LOCKOUT,
};

function fail(reason: string): never {
  console.error(`auth.ts: ${reason}`);
  process.exit(1);
}

for (const [name, value] of Object.entries(functions)) {
  if (typeof value !== 'function') {
    fail(`${name} is not a function`);
  }
}

for (const [name, value] of Object.entries(errorClasses)) {
  if (
    typeof value !== 'function' ||
    !(value.prototype instanceof Error) ||
    !Function.prototype.toString.call(value).startsWith('class')
  ) {
    fail(`${name} is not an Error subclass`);
  }
}

for (const [name, value] of Object.entries(numbers)) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} is not a positive integer`);
  }
}

for (const [name, value] of Object.entries(strings)) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is not a non-empty string`);
  }
}

for (const [name, value] of Object.entries(frozenArrays)) {
  if (!Array.isArray(value) || value.length === 0 || !Object.isFrozen(value)) {
    fail(`${name} is not a non-empty frozen array`);
  }
}

for (const [name, value] of Object.entries(frozenObjects)) {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
    fail(`${name} is not a frozen object`);
  }
}

const documentedValueCount =
  Object.keys(functions).length +
  Object.keys(errorClasses).length +
  Object.keys(numbers).length +
  Object.keys(strings).length +
  Object.keys(frozenArrays).length +
  Object.keys(frozenObjects).length;

const exportedNames = Object.keys(auth);
if (exportedNames.length !== documentedValueCount) {
  fail(
    `the entry point exports ${exportedNames.length} values, the probe knows ${documentedValueCount}`,
  );
}

const reachable: Record<string, unknown> = auth;
for (const internal of [
  'generateTokenValue',
  'tokenIdentifier',
  'FIRST_USER_LOCK_KEY',
  'auditLog',
  'verification',
]) {
  if (reachable[internal] !== undefined) {
    fail(`${internal} must not be reachable from the entry point`);
  }
}

if (!DISABLED_AUTH_PATHS.includes('/admin/set-role')) {
  fail('DISABLED_AUTH_PATHS does not close the admin-plugin routes');
}

// Pure calls: redaction and rendering never touch a connection or a sender.
const redacted = redactAuditPayload({ password: 'not-a-real-password' });
if (
  JSON.stringify(redacted) !== JSON.stringify({ password: REDACTION_MARKER })
) {
  fail('redactAuditPayload did not redact a password');
}
const twoFactorKind: AuthEmailKind = 'two-factor-code';
const rendered: MailMessage = renderAuthEmail(twoFactorKind, {
  to: 'someone@example.com',
  code: '123456',
  expiresInMinutes: '5',
});
if (!rendered.text.includes('123456')) {
  fail('renderAuthEmail did not render the code');
}
const superadmin: TwoFactorSubject = {
  roleKey: SUPERADMIN_ROLE_KEY,
  twoFactorEnabled: false,
};
if (!needsTwoFactorEnrolment(superadmin)) {
  fail('an unenrolled superadmin must need two-factor enrolment');
}

// Type proofs: one declaration per exported type, so the packed
// declarations must resolve every name for this file to type-check.
const actor: AuditActor = { userId: 'user-id', roleKey: 'editor' };
const entry: AuditEntryInput = {
  permission: 'users:create',
  action: USER_INVITE_ACTION,
  entityType: 'user',
};
const party: ImpersonationParty = { userId: 'user-id', roleKey: 'editor' };
const session: ImpersonatableSession = {
  userId: 'user-id',
  roleKey: 'editor',
};
const refusal: ImpersonationRefusalReason = 'target-is-self';
const sessionRefusal: ImpersonationSessionRefusalReason = 'no-session';
const smtp: SmtpOptions = { host: 'smtp.example.com', port: 587 };
const senderKind: MailSenderKind = 'smtp';
const tokenPurpose: TokenPurpose = 'magic-link';
const linkPurpose: PasswordLinkPurpose = 'set-password';
const outcome: PasswordLinkRequestOutcome = { delivered: true };
const inviteField: InviteField = 'email';
const clock: TokenClockOptions = { now: () => new Date(0) };
const pruneOptions: PruneAuditLogOptions = { retentionDays: 365 };
const redactOptions: RedactAuditPayloadOptions = { maxDepth: 8 };
const issueInput: IssueSingleUseTokenInput = {
  subjectId: 'user-id',
  purpose: tokenPurpose,
  ttlSeconds: SET_PASSWORD_TOKEN_TTL_SECONDS,
};
const consumeInput: ConsumeSingleUseTokenInput = {
  purpose: tokenPurpose,
  token: 'not-a-token',
};
const requestInput: RequestPasswordLinkInput = {
  email: 'someone@example.com',
  purpose: linkPurpose,
};
const completeInput: CompleteSetPasswordInput = {
  purpose: linkPurpose,
  token: 'not-a-token',
  newPassword: 'a long enough password',
};
const createUserInput: CreateUserInput = {
  id: 'user-id',
  email: 'someone@example.com',
  name: 'Someone',
  roleKey: 'editor',
};
const createUserOptions: CreateUserOptions = { now: () => new Date(0) };
const createUserResult: CreateUserResult = {
  userId: 'user-id',
  roleKey: 'editor',
  wasFirstUser: false,
};
const inviteInput: InviteUserInput = {
  email: 'someone@example.com',
  name: 'Someone',
  roleKey: 'editor',
  actor,
};
const inviteResult: InviteUserResult = {
  userId: 'user-id',
  wasFirstUser: false,
};
const resendInput: ResendSetPasswordLinkInput = {
  email: 'someone@example.com',
  actor,
};
const probe: PasswordLinkProbe = {};
const failureHook: AuditFailureHook = () => undefined;
const mailSender: MailSender = { send: () => Promise.resolve() };
const renderEmail: RenderAuthEmail = renderAuthEmail;
const consoleOptions: CreateConsoleSenderOptions = {
  from: 'cms@example.com',
  nodeEnv: 'development',
  write: () => undefined,
};
const smtpSenderOptions: CreateSmtpSenderOptions = {
  smtp,
  from: 'cms@example.com',
};
const mailSenderOptions: CreateMailSenderOptions = { from: 'cms@example.com' };
const transportConfig: SmtpTransportConfig = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTLS: true,
  pool: true,
  connectionTimeout: 1,
  greetingTimeout: 1,
  socketTimeout: 1,
};
const transportMessage: SmtpTransportMessage = {
  from: 'cms@example.com',
  to: 'someone@example.com',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
};
const transport: SmtpTransport = { sendMail: () => Promise.resolve(null) };
const createTransport: CreateSmtpTransport = () => transport;

// Types that describe live handles (a database, a transaction, a
// better-auth instance) are proven as parameter types: the function is
// never called, so no handle is ever needed.
function acceptsLiveHandles(
  _auth: Auth,
  _authOptions: CreateAuthOptions,
  _auditDatabase: AuditDatabase,
  _auditDeps: AuditDeps,
  _auditRecorder: AuditRecorder,
  _auditTransaction: AuditTransaction,
  _auditWriteFailure: AuditWriteFailure,
  _auditedMutation: AuditedMutation<string>,
  _authorizeWithToken: AuthorizeWithToken<string>,
  _tokenDatabase: TokenDatabase,
  _tokenTransaction: TokenTransaction,
  _userCreationExecutor: UserCreationExecutor,
  _requestDeps: RequestPasswordLinkDeps,
  _completeDeps: CompleteSetPasswordDeps,
  _inviteDeps: InviteDeps,
  _impersonationDeps: ImpersonationDeps,
  _impersonationResult: ImpersonationSessionResult,
): number {
  return 17;
}

const typeProofs: unknown[] = [
  actor,
  entry,
  party,
  session,
  refusal,
  sessionRefusal,
  smtp,
  senderKind,
  tokenPurpose,
  linkPurpose,
  outcome,
  inviteField,
  clock,
  pruneOptions,
  redactOptions,
  issueInput,
  consumeInput,
  requestInput,
  completeInput,
  createUserInput,
  createUserOptions,
  createUserResult,
  inviteInput,
  inviteResult,
  resendInput,
  probe,
  failureHook,
  mailSender,
  renderEmail,
  consoleOptions,
  smtpSenderOptions,
  mailSenderOptions,
  transportConfig,
  transportMessage,
  transport,
  createTransport,
  twoFactorKind,
  rendered,
  superadmin,
];

console.log(
  `auth.ts: ${documentedValueCount} values of the expected kinds and ${typeProofs.length + acceptsLiveHandles.length} typed declarations resolve against the packed package (no connection opened, nothing sent)`,
);
