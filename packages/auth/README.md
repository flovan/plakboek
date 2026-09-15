# @plakboek/auth

better-auth wiring, invite, audit and impersonation primitives for Plakboek
CMS installations: session issuance/validation, email/password with a
length-only strength rule, two-factor authentication (TOTP and email OTP),
magic links, audited impersonation, and the audit-log hook every
permission-gated mutation writes through.

## Install

```sh
pnpm add @plakboek/auth
```

## Status

The Phase 2 (Authentication, Sessions & Audit Trail) surface is complete.
Everything a host needs is exported from the package entry point and listed
below. Routes, screens and the bootstrap wizard that call these functions
belong to the host and to later phases.

## Public API

Every export of `@plakboek/auth`, grouped the way `src/index.ts` groups
them. `tests/unit/public-api.test.ts` compares these tables with the
entry point, so an export cannot be added or removed without updating
them.

Nothing else is reachable from the entry point. In particular the token
value generator, the stored-identifier builder, the advisory lock keys and
the schema tables stay internal: with them a consumer could write a
`verification`, `session` or `audit_log` row around the issue, consume and
audited paths described here.

### Configuration and policy

| Export                              | Kind     | Purpose                                                                                                                                                             |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAuth`                        | function | Builds the better-auth instance for one installation from injected options: sliding sessions, audited two-factor, magic links, closed routes and the password floor |
| `AuthConfigError`                   | class    | Thrown by `createAuth` for an invalid option; names the option, never the value                                                                                     |
| `SESSION_EXPIRES_IN_SECONDS`        | constant | `2592000` (30 days): how long a session lives after its last refresh                                                                                                |
| `SESSION_UPDATE_AGE_SECONDS`        | constant | `86400` (one day): how old a session must be before a request slides its expiry                                                                                     |
| `IMPERSONATION_SESSION_TTL_SECONDS` | constant | `28800` (8 hours): the fixed lifetime of an impersonation session, which never slides                                                                               |
| `SET_PASSWORD_TOKEN_TTL_SECONDS`    | constant | `172800` (48 hours): lifetime of set-password and reset-password links                                                                                              |
| `MAGIC_LINK_TTL_SECONDS`            | constant | `900` (15 minutes): lifetime of a magic link                                                                                                                        |
| `TWO_FACTOR_CODE_TTL_SECONDS`       | constant | `300` (5 minutes): lifetime of an emailed second-factor code                                                                                                        |
| `TWO_FACTOR_LOCKOUT`                | constant | Frozen `{ maxFailedAttempts: 5, durationSeconds: 900 }`, one counter shared by authenticator and emailed codes                                                      |
| `DISABLED_AUTH_PATHS`               | constant | Frozen list of better-auth HTTP routes that answer 404; the full list and the reason are under the security notes                                                   |
| `Auth`                              | type     | The better-auth instance `createAuth` returns                                                                                                                       |
| `CreateAuthOptions`                 | type     | `db`, `baseURL`, `secret`, `mail`, `roles`, and optionally `appName`, `minPasswordLength`, `renderEmail`, `onMailDeliveryError`, `onAuditWriteFailed`               |
| `RenderAuthEmail`                   | type     | A template renderer a host can pass as `renderEmail` to theme the emails                                                                                            |

### Passwords

| Export                 | Kind     | Purpose                                                                                                                                                                            |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_MIN_LENGTH`  | constant | `12`: the floor, counted in code points, with no composition rules; `createAuth`'s `minPasswordLength` may raise it but never lower it                                             |
| `assertPasswordPolicy` | function | Throws `PasswordPolicyError` for a password below `PASSWORD_MIN_LENGTH`, or below a higher `minLength` passed as the second argument; a non-integer `minLength` throws `TypeError` |
| `PasswordPolicyError`  | class    | Carries `minLength`, the minimum that was enforced; never the rejected password                                                                                                    |

### Users

| Export                 | Kind     | Purpose                                                                                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `createUserWithRole`   | function | The one user-creation primitive: the first user on an empty table becomes `superadmin`, and the address is stored trimmed and lower-cased |
| `SUPERADMIN_ROLE_KEY`  | constant | `'superadmin'`                                                                                                                            |
| `CreateUserInput`      | type     | `id`, `email`, `name`, `roleKey`, and an optional better-auth `passwordHash` that also creates a credential account                       |
| `CreateUserOptions`    | type     | An optional clock                                                                                                                         |
| `CreateUserResult`     | type     | `userId`, the stored `roleKey`, and `wasFirstUser`                                                                                        |
| `UserCreationExecutor` | type     | The database or an enclosing transaction                                                                                                  |

### Audit log

| Export                  | Kind     | Purpose                                                                                                                                                                                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAuditRecorder`   | function | Binds database, permission resolver, failure hook and clock, and returns an `AuditRecorder`: the single call site for gated mutations                                                                                                    |
| `runAuditedMutation`    | function | The unbound form of `run`: permission check, mutation and audit row in one transaction                                                                                                                                                   |
| `PermissionDeniedError` | class    | Thrown once a refusal has been recorded; carries the permission and role key only                                                                                                                                                        |
| `AuditWriteError`       | class    | The audit row could not be written, so the mutation was rolled back; a self-service change was already made and is not undone                                                                                                            |
| `AuditActor`            | type     | The acting user's id and role key, and `impersonatedBy` while impersonating                                                                                                                                                              |
| `AuditDatabase`         | type     | Any Drizzle Postgres handle that can open a transaction                                                                                                                                                                                  |
| `AuditDeps`             | type     | `db`, `resolver`, and optionally `onAuditWriteFailed` and `now`                                                                                                                                                                          |
| `AuditEntryInput`       | type     | Permission, action, entity and the before and after states of one audit row                                                                                                                                                              |
| `AuditFailureHook`      | type     | Called once per failed audit write, after the rollback                                                                                                                                                                                   |
| `AuditRecorder`         | type     | `run(actor, entry, mutation)` for gated mutations, `recordDenied(actor, entry)` for a refusal made for another reason, and `recordSelfService(actor, entry)` for a user's change to their own account, stored with `permission` `'self'` |
| `AuditTransaction`      | type     | The transaction a mutation runs in                                                                                                                                                                                                       |
| `AuditWriteFailure`     | type     | What the failure hook receives: identifiers and the error, never the payload                                                                                                                                                             |
| `AuditedMutation`       | type     | A mutation that runs inside the audit transaction and returns `{ result, after }`                                                                                                                                                        |

### Audit payload redaction

| Export                      | Kind     | Purpose                                                         |
| --------------------------- | -------- | --------------------------------------------------------------- |
| `REDACTED_KEYS`             | constant | Frozen, normalised keys whose values never reach an audit row   |
| `REDACTION_MARKER`          | constant | `'[redacted]'`, written in place of such a value                |
| `redactAuditPayload`        | function | Returns the redacted copy of a payload that the recorder stores |
| `RedactAuditPayloadOptions` | type     | An optional `maxDepth`                                          |

### Retention prune

| Export                 | Kind     | Purpose                                                                                                    |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `pruneAuditLog`        | function | Deletes audit rows older than the retention window and returns how many; the host schedules it (see below) |
| `AUDIT_RETENTION_DAYS` | constant | `365`                                                                                                      |
| `PruneAuditLogOptions` | type     | Optional `retentionDays` and `now`                                                                         |

### Single-use tokens

| Export                       | Kind     | Purpose                                                                                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `issueSingleUseToken`        | function | Issues a token for a subject and purpose, deleting every earlier token of that purpose for that subject; stores only a SHA-256 digest |
| `consumeSingleUseToken`      | function | Deletes the token and runs the action it authorises in one transaction; if the action throws, the token stays valid                   |
| `InvalidOrExpiredTokenError` | class    | One error for a never-issued, consumed or expired token; carries the purpose only                                                     |
| `TOKEN_PURPOSES`             | constant | Frozen `['set-password', 'reset-password', 'magic-link']`                                                                             |
| `TokenPurpose`               | type     | One of `TOKEN_PURPOSES`                                                                                                               |
| `TokenDatabase`              | type     | The database or an enclosing transaction                                                                                              |
| `TokenTransaction`           | type     | The transaction an authorised action runs in                                                                                          |
| `IssueSingleUseTokenInput`   | type     | `subjectId`, `purpose`, `ttlSeconds`                                                                                                  |
| `ConsumeSingleUseTokenInput` | type     | `purpose`, `token`                                                                                                                    |
| `TokenClockOptions`          | type     | An optional clock                                                                                                                     |
| `AuthorizeWithToken`         | type     | The action a consumed token authorises, given the transaction and the subject id                                                      |

### Password links

| Export                       | Kind     | Purpose                                                                                                                                                                                                |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestPasswordLink`        | function | Emails a set-password or reset-password link; the same work and the same result for any address, and the send is not awaited                                                                           |
| `completeSetPassword`        | function | Checks the password against the minimum `createAuth` configured, then in one transaction consumes the link, writes the credential, revokes sessions and other links, and writes a `credential.set` row |
| `CredentialWriteError`       | class    | The credential write failed; carries error types and SQLSTATE and deliberately has no `cause`, which would quote the password hash                                                                     |
| `PASSWORD_LINK_PATHS`        | constant | Frozen landing paths `/cms/set-password` and `/cms/reset-password`; the token travels in `?token=`                                                                                                     |
| `CREDENTIAL_SET_ACTION`      | constant | `'credential.set'`                                                                                                                                                                                     |
| `PasswordLinkPurpose`        | type     | `'set-password'` or `'reset-password'`                                                                                                                                                                 |
| `PasswordLinkRequestOutcome` | type     | `{ delivered: true }`, the only outcome                                                                                                                                                                |
| `PasswordLinkProbe`          | type     | Test observation points fired on both the known-address and unknown-address branch                                                                                                                     |
| `RequestPasswordLinkDeps`    | type     | `db`, `mail`, `baseURL`, and optionally `renderEmail`, `onDeliveryError`, `probe`                                                                                                                      |
| `RequestPasswordLinkInput`   | type     | `email`, `purpose`                                                                                                                                                                                     |
| `CompleteSetPasswordDeps`    | type     | `db`, `auth` (better-auth's hasher and the configured `minPasswordLength`), and optionally `onAuditWriteFailed`, `now`                                                                                 |
| `CompleteSetPasswordInput`   | type     | `purpose`, `token`, `newPassword`                                                                                                                                                                      |

### Invitations

| Export                            | Kind     | Purpose                                                                                                                                |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `inviteUser`                      | function | Needs `users:create`. Creates the user with no credential through `createUserWithRole` and emails a set-password link after the commit |
| `resendSetPasswordLink`           | function | Needs `users:create`. Issues a fresh link, a reset-password link once a password exists, which ends the previous one                   |
| `InviteDeliveryError`             | class    | The user and link are committed but the message was not delivered; carries `userId` and `recipientDomain`                              |
| `InvalidInviteError`              | class    | Invalid invite input; carries the `field` only                                                                                         |
| `InviteWriteError`                | class    | A database failure inside an invite; carries error types and SQLSTATE, no `cause`                                                      |
| `USER_INVITE_ACTION`              | constant | `'user.invite'`                                                                                                                        |
| `USER_RESEND_SET_PASSWORD_ACTION` | constant | `'user.resend-set-password'`                                                                                                           |
| `InviteDeps`                      | type     | `recorder` (bound to the database, not a transaction), `mail`, `baseURL`, and optionally `renderEmail`                                 |
| `InviteUserInput`                 | type     | `email`, `name`, `roleKey`, `actor`, and an optional `id` for a bootstrap where the invitee is also the actor                          |
| `InviteUserResult`                | type     | `userId`, `wasFirstUser`                                                                                                               |
| `ResendSetPasswordLinkInput`      | type     | `email`, `actor`                                                                                                                       |
| `InviteField`                     | type     | `'email'`, `'name'`, `'roleKey'` or `'id'`                                                                                             |

### Impersonation

| Export                              | Kind     | Purpose                                                                                                                                                             |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startImpersonation`                | function | Audited start from the request `headers`: needs `users:impersonate`, refuses superadmin and self targets, returns `sessionToken`, `expiresAt` and `responseHeaders` |
| `stopImpersonation`                 | function | Audited stop from the request `headers`; restores the impersonating user's own session and returns the same shape                                                   |
| `assertImpersonationTargetAllowed`  | function | Throws `ImpersonationTargetForbiddenError` for a superadmin or self target                                                                                          |
| `auditActorFromSession`             | function | The audit actor for a session: the impersonated user acts and the impersonating user is recorded as `impersonatedBy`                                                |
| `ImpersonationTargetForbiddenError` | class    | Carries `targetUserId` and `reason`                                                                                                                                 |
| `ImpersonationSessionError`         | class    | The presented session cannot start or stop: `no-session`, `not-impersonating` or `already-impersonating`                                                            |
| `ImpersonatableSession`             | type     | `userId`, `roleKey`, and `impersonatedBy` while impersonating                                                                                                       |
| `ImpersonationParty`                | type     | A user id and role key                                                                                                                                              |
| `ImpersonationRefusalReason`        | type     | `'target-is-superadmin'` or `'target-is-self'`                                                                                                                      |
| `ImpersonationDeps`                 | type     | `auth`, `recorder`, `db`                                                                                                                                            |
| `ImpersonationSessionResult`        | type     | `sessionToken`, `expiresAt`, `responseHeaders`                                                                                                                      |
| `ImpersonationSessionRefusalReason` | type     | `'no-session'`, `'not-impersonating'` or `'already-impersonating'`                                                                                                  |

### Two-factor gate

| Export                            | Kind     | Purpose                                                                                                        |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `assertTwoFactorSatisfied`        | function | Throws `TwoFactorEnrolmentRequiredError` when the subject's role requires a second factor that is not enrolled |
| `needsTwoFactorEnrolment`         | function | The same decision as a boolean                                                                                 |
| `isTwoFactorRequiredForRole`      | function | Whether a role key requires a second factor; only `superadmin` does                                            |
| `TWO_FACTOR_REQUIRED_ROLE_KEYS`   | constant | Frozen `['superadmin']`                                                                                        |
| `TWO_FACTOR_ENROLMENT_PATH`       | constant | `/cms/settings/2fa/enrol`, where a gated user is sent                                                          |
| `TwoFactorEnrolmentRequiredError` | class    | Carries `redirectTo` and `roleKey` only                                                                        |
| `TwoFactorSubject`                | type     | The role key and `twoFactorEnabled` flag, read from the session's user row                                     |

### Mail senders

| Export                       | Kind     | Purpose                                                                                                                  |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `createMailSender`           | function | Returns `{ sender, kind }`: the SMTP sender for a non-blank host, otherwise the console sender, which production refuses |
| `createSmtpSender`           | function | A pooled SMTP sender with mandatory TLS and bounded timeouts                                                             |
| `createConsoleSender`        | function | A development sender that prints each message; throws when `NODE_ENV` is `production`                                    |
| `MailSenderConfigError`      | class    | Invalid sender options; names the field, never the value                                                                 |
| `SmtpOptions`                | type     | `host`, and optionally `port`, `secure`, `user`, `pass`                                                                  |
| `SmtpTransport`              | type     | The transport a sender sends through                                                                                     |
| `SmtpTransportConfig`        | type     | The exact configuration handed to the transport factory                                                                  |
| `SmtpTransportMessage`       | type     | One message as handed to the transport                                                                                   |
| `CreateSmtpTransport`        | type     | A transport factory; tests inject a fake so no socket opens                                                              |
| `CreateSmtpSenderOptions`    | type     | `smtp`, `from`, and optionally `createTransport`                                                                         |
| `CreateConsoleSenderOptions` | type     | `from`, and optionally `nodeEnv`, `write`                                                                                |
| `CreateMailSenderOptions`    | type     | Optional `smtp`, `from`, and optionally `nodeEnv`, `write`, `createTransport`                                            |
| `MailSenderKind`             | type     | `'smtp'` or `'console'`                                                                                                  |

### Email templates

| Export             | Kind     | Purpose                                                                                                      |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `renderAuthEmail`  | function | Renders a set-password, reset-password, magic-link or two-factor-code message with html and plain-text parts |
| `AUTH_EMAIL_KINDS` | constant | Frozen list of those four kinds                                                                              |
| `AuthEmailKind`    | type     | One of `AUTH_EMAIL_KINDS`                                                                                    |

### Mail contract

| Export          | Kind  | Purpose                                                    |
| --------------- | ----- | ---------------------------------------------------------- |
| `MailSendError` | class | A failed send; names only the recipient's domain           |
| `MailMessage`   | type  | `to`, `subject`, `html`, `text`                            |
| `MailSender`    | type  | `send(message)`, rejecting with `MailSendError` on failure |

## Configuration

The host supplies these environment variables. The package reads none of
them from the ambient environment: the host reads its own environment and
passes plain values to `createAuth` and `createMailSender`. The only
ambient read in the package is `NODE_ENV`, and only when
`createMailSender` or `createConsoleSender` is called without `nodeEnv`.

| Variable               | Passed as                                                  | Notes                                                                               |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | `createAuth({ secret })`                                   | At least 32 characters; signs session cookies                                       |
| `BETTER_AUTH_URL`      | `createAuth({ baseURL })`, and `baseURL` of the link flows | Absolute URL of the installation; links are built against it                        |
| `PLAKBOEK_SMTP_HOST`   | `createMailSender({ smtp: { host } })`                     | Empty selects the console sender outside production and fails at boot in production |
| `PLAKBOEK_SMTP_PORT`   | `smtp.port`, as a number                                   | Defaults to 587 (STARTTLS required), or 465 when `secure` is true                   |
| `PLAKBOEK_SMTP_SECURE` | `smtp.secure`, as a boolean                                | `true` only for implicit TLS on 465; the string `'false'` is rejected, so parse it  |
| `PLAKBOEK_SMTP_USER`   | `smtp.user`                                                | Supplied together with the password, or both omitted for an unauthenticated relay   |
| `PLAKBOEK_SMTP_PASS`   | `smtp.pass`                                                | See above                                                                           |
| `PLAKBOEK_MAIL_FROM`   | `createMailSender({ from })`                               | One address the SMTP account may send as                                            |

```ts
import { createAuth, createMailSender, type SmtpOptions } from '@plakboek/auth';
import { createDb } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';

const env = process.env;
const smtp: SmtpOptions = {
  host: env.PLAKBOEK_SMTP_HOST ?? '',
  port: Number(env.PLAKBOEK_SMTP_PORT ?? '587'),
  secure: env.PLAKBOEK_SMTP_SECURE === 'true',
  ...(env.PLAKBOEK_SMTP_USER
    ? { user: env.PLAKBOEK_SMTP_USER, pass: env.PLAKBOEK_SMTP_PASS ?? '' }
    : {}),
};
const { sender, kind } = createMailSender({
  smtp,
  from: env.PLAKBOEK_MAIL_FROM ?? '',
});
console.info(`mail sender: ${kind}`); // 'smtp' or, outside production, 'console'

const database = createDb({ connectionString: env.DATABASE_URL ?? '' });
const auth = createAuth({
  db: database.db,
  baseURL: env.BETTER_AUTH_URL ?? '',
  secret: env.BETTER_AUTH_SECRET ?? '',
  mail: sender,
  roles: defineRoles(defaultRoles),
  // reportToMonitoring stands for the host's own error reporting.
  onMailDeliveryError: (error) => reportToMonitoring(error),
});
```

### Mail delivery

Mail goes out over SMTP only, so any SMTP server works:

- a dedicated mailbox on the customer's own mail server, or
- the SMTP endpoint of an EU transactional relay, for example Lettermint
  (NL) or Scaleway Transactional Email (FR).

TLS is mandatory. Port 587 requires STARTTLS and port 465 uses implicit
TLS; there is no plaintext option, so a server that cannot upgrade fails
the send. The sending domain needs SPF, DKIM and DMARC records for the
chosen server, or messages will land in spam or be refused.

An empty `PLAKBOEK_SMTP_HOST` selects the console sender, which prints
each message, link included, for local development. In production that
same configuration throws `MailSenderConfigError` when the sender is
created, so a missing mail setup fails at boot rather than silently.

Mail on unauthenticated paths is fire-and-forget. A magic-link request and
a password-reset request dispatch the send without awaiting it, so the
response time cannot reveal whether an address is registered, and the
requester never learns of a delivery failure. The host does, through a
hook:

- `createAuth`'s `onMailDeliveryError` receives failed magic-link and
  emailed second-factor sends;
- `requestPasswordLink`'s `onDeliveryError` receives failed set-password
  and reset-password link sends.

Both default to one `console.error` line naming the error type and the
recipient's domain. Invitations and resends are privileged, so they await
the send and throw `InviteDeliveryError` instead.

## Security notes

### Properties a host must not undo

1. **The audit row shares the mutation's transaction.** Route every
   permission-gated mutation through `AuditRecorder.run`. If the audit
   row cannot be written, the mutation rolls back. Never write to
   `audit_log` directly and never catch `AuditWriteError` to carry on.
2. **Only the most recently issued link of a purpose is valid.** Issuing a
   set-password or reset-password link deletes every earlier one of that
   purpose for that user, so a resend invalidates the previous email.
   Tokens are stored as SHA-256 digests; magic-link tokens and emailed
   codes are stored hashed too.
3. **Consuming a link and performing the action it authorises share one
   transaction.** `completeSetPassword` consumes the link, writes the
   credential, revokes every session of the user and every impersonation
   they started, ends their other outstanding links and writes the audit
   row together. Never call better-auth's `auth.api.resetPassword` or
   `auth.api.requestPasswordReset`, even server-side: they spend a token
   and write a password in separate steps.
4. **Superadmin accounts require a second factor before reaching any
   protected route.** Every protected loader calls
   `assertTwoFactorSatisfied` with the role key and `two_factor_enabled`
   from the session's user row, never from client input, and redirects to
   the error's `redirectTo`.

### Closed HTTP routes

`DISABLED_AUTH_PATHS` lists better-auth routes that answer 404 to any HTTP
request, whatever its method, trailing slashes or query string. Each one
would let a caller reach an action around a guarantee this package builds:

- `/sign-up/email`
- `/admin/ban-user`
- `/admin/create-user`
- `/admin/get-user`
- `/admin/has-permission`
- `/admin/impersonate-user`
- `/admin/list-user-sessions`
- `/admin/list-users`
- `/admin/remove-user`
- `/admin/revoke-user-session`
- `/admin/revoke-user-sessions`
- `/admin/set-role`
- `/admin/set-user-password`
- `/admin/stop-impersonating`
- `/admin/unban-user`
- `/admin/update-user`
- `/request-password-reset`
- `/reset-password`
- `/reset-password/:token`
- `/change-password`
- `/update-user`
- `/change-email`
- `/delete-user`
- `/delete-user/callback`

Why they are closed:

- **Sign-up.** Users are created only by the first-user rule and by
  invitation, never by self-registration.
- **Every admin-plugin route.** Creating, updating, banning or removing a
  user, setting a role or password, and listing or revoking sessions over
  these routes would skip the first-user rule, the audit log and the
  set-password flow. The plugin's role map grants its impersonate statement
  only to roles holding `users:impersonate`, and no user-management
  statement to any role; closing the routes means a later change to that
  map cannot reopen them. Impersonation runs only through the audited
  `startImpersonation` and `stopImpersonation`, which call the plugin
  through `auth.api`.
- **The built-in reset routes.** Set and reset run only through the
  transactional single-use-token flow above.
- **Self-service account routes.** Changing your own password, name or
  address, or deleting your own account, would write no audit row; self-service
  account changes arrive audited in Phase 11. Do not call their `auth.api`
  counterparts either.

The `:token` segment is enforced by this package's own request guard, since
better-auth's `disabledPaths` compares paths literally. A host that mounts
`auth.handler` needs to do nothing extra. Server-side `auth.api` calls are
not affected.

### Host responsibilities

- **Resending needs `users:create`.** `resendSetPasswordLink` checks the
  same permission as `inviteUser`; `users:reset-password` alone is not
  enough. A role that should resend links needs `users:create`.
- **Create every user through `createUserWithRole` or `inviteUser`.** They
  apply the first-user rule and store the address trimmed and lower-cased,
  which is the form sign-in, link requests and invitations look up. A seed
  that inserts user rows any other way must store
  `email.trim().toLowerCase()` itself, or those users cannot be found and
  may be created twice.
- **Bootstrap the first user with an explicit id.** On an empty
  installation no other user can be the audit actor, so call `inviteUser`
  with `id` set and `actor` naming that same id as `superadmin`.
- **Bind the invite recorder to the database.** `inviteUser` and
  `resendSetPasswordLink` send after their transaction commits; a recorder
  bound to an enclosing transaction would send before that commit.
- **Impersonation lapses after 8 hours.** An impersonation session expires
  `IMPERSONATION_SESSION_TTL_SECONDS` after it starts unless it is stopped
  sooner, whatever cookies later requests carry; ordinary sessions keep
  sliding. `startImpersonation` and `stopImpersonation` take the request
  headers, and the route must forward their `responseHeaders` to the
  browser, or the stop cannot find the impersonating user's session. Never
  extend a session's `expiresAt` through better-auth's adapter directly.
- **`users:impersonate` is what lets a role impersonate.** The shipped
  roles grant it only to `superadmin`. A host role given it can start and
  stop impersonations through `startImpersonation` and `stopImpersonation`,
  every row names both people (D-11), and a superadmin is never a target
  (D-13). A role that should never act as another user must not hold it.
- **Report mail delivery failures.** Unauthenticated sends are
  fire-and-forget (see Mail delivery); pass `onMailDeliveryError` and
  `onDeliveryError` so failures reach monitoring.
- **Report two-factor audit failures.** Enabling and disabling two-factor
  stay open over HTTP. Each successful call writes a `two-factor.enabled`
  or `two-factor.disabled` row with `permission` `'self'`, after the plugin
  has saved the change. A failed row cannot undo that change: the call
  answers `AUDIT_WRITE_FAILED` and `createAuth`'s `onAuditWriteFailed`
  receives the failure, so pass it.
- **Schedule the audit log prune.** The package never runs
  `pruneAuditLog` itself; see the next section.
- **Rate-limit the unauthenticated endpoints** (sign-in, magic link,
  password-link requests) at the HTTP edge. The package keeps their
  responses uniform but does not throttle them.

## Audit log retention

Every permission-gated mutation writes one row to `audit_log`. Rows are
kept for one year (`AUDIT_RETENTION_DAYS`, 365 days). `pruneAuditLog`
enforces that window. It runs one `DELETE` that removes every row created
strictly before now minus the window, and returns how many rows it
deleted. A row exactly at the cutoff is kept. The window can be passed as
`retentionDays`; anything other than a positive whole number of days
throws before a statement runs, so a bad value can never empty the table.

```ts
const deleted = await pruneAuditLog(db); // rows older than 365 days
```

**The host calls it on a schedule. The package never does.** Once a day is
enough: each run then deletes about one day's worth of rows. Two ways to
schedule it, once the hosting choice is made:

- **A scheduled CI workflow** that runs a small script from the host repo.
  This fits when the database accepts connections from the CI runner.

  ```ts
  // scripts/prune-audit-log.ts
  import { pruneAuditLog } from '@plakboek/auth';
  import { createDb } from '@plakboek/db';

  const database = createDb({
    connectionString: process.env.DATABASE_URL ?? '',
  });
  try {
    const deleted = await pruneAuditLog(database.db);
    console.log(`audit log: pruned ${deleted} rows`);
  } finally {
    await database.close();
  }
  ```

  ```yaml
  # .github/workflows/prune-audit-log.yml
  name: Prune audit log
  on:
    schedule:
      - cron: '17 3 * * *'
    workflow_dispatch:
  jobs:
    prune:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v5
        - uses: pnpm/action-setup@v4
        - uses: actions/setup-node@v5
          with:
            node-version: 22
            cache: pnpm
        - run: pnpm install --frozen-lockfile
        - run: node scripts/prune-audit-log.ts
          env:
            DATABASE_URL: ${{ secrets.DATABASE_URL }}
  ```

- **A systemd timer** on the server that runs the same script. This fits
  when the database is only reachable from that machine.

  ```ini
  # /etc/systemd/system/plakboek-audit-prune.service
  [Unit]
  Description=Prune Plakboek audit log rows past the retention window

  [Service]
  Type=oneshot
  WorkingDirectory=/srv/site
  EnvironmentFile=/srv/site/.env
  ExecStart=/usr/bin/node scripts/prune-audit-log.ts
  ```

  ```ini
  # /etc/systemd/system/plakboek-audit-prune.timer
  [Unit]
  Description=Run the Plakboek audit log prune daily

  [Timer]
  OnCalendar=daily
  RandomizedDelaySec=1h
  Persistent=true

  [Install]
  WantedBy=timers.target
  ```

  Enable it with `systemctl enable --now plakboek-audit-prune.timer`.

This package deliberately ships no scheduler, no queue and no job registry:
`pruneAuditLog` is its only retention entry point. Choosing what calls it
is a hosting decision for Phase 6, not a gap in Phase 2.

## Requirement coverage

Each Phase 2 requirement and the automated cases that prove it. Paths are
relative to `packages/auth`. Two commands run them, from the repository
root:

- **unit:** `pnpm --filter @plakboek/auth run test`
- **integration:** `docker compose up -d --wait postgres`, then
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres pnpm --filter @plakboek/auth run test:integration`

| Requirement | Test file                                                 | Case                                                                                                | Command     |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------- |
| AUTH-01     | `tests/integration/tracer-first-user-login-audit.test.ts` | runs the whole path against a real Postgres (the first user resolves to every catalogue permission) | integration |
| AUTH-01     | `tests/integration/tracer-first-user-login-audit.test.ts` | grants superadmin to exactly one of two concurrent first-user creations                             | integration |
| AUTH-01     | `tests/integration/invite.test.ts`                        | forces superadmin on the first user of an empty installation, whatever role was asked for           | integration |
| AUTH-02     | `tests/integration/invite.test.ts`                        | creates the user with the requested role and mails one link that sets a password                    | integration |
| AUTH-02     | `tests/integration/invite.test.ts`                        | keeps the user and the link when delivery fails, and a resend recovers                              | integration |
| AUTH-02     | `tests/unit/invite-guards.test.ts`                        | refuses a caller without users:create, records the denial and creates nothing                       | unit        |
| AUTH-03     | `tests/integration/invite.test.ts`                        | stops completing once the link is 48 hours old, and completes at 47 hours                           | integration |
| AUTH-03     | `tests/integration/set-password.test.ts`                  | spends the link on success, so presenting it again is rejected                                      | integration |
| AUTH-03     | `tests/unit/token-expiry.test.ts`                         | rejects a token at the exact instant of expiry                                                      | unit        |
| AUTH-04     | `tests/integration/invite.test.ts`                        | invalidates the previously issued link, leaving exactly one valid link                              | integration |
| AUTH-04     | `tests/integration/invite.test.ts`                        | issues a reset-password link, recorded in the audit log, for a user who already set a password      | integration |
| AUTH-04     | `tests/integration/invite.test.ts`                        | lets a role holding only users:create resend, with an allowed row naming that permission            | integration |
| AUTH-05     | `tests/integration/set-password.test.ts`                  | resets a password through the emailed link, and the new password signs in                           | integration |
| AUTH-05     | `tests/integration/reset-timing.test.ts`                  | does the same counted work for a known and an unknown address                                       | integration |
| AUTH-05     | `tests/unit/credentials-timing.test.ts`                   | resolves for a known address even when the send never settles                                       | unit        |
| AUTH-06     | `tests/unit/password-policy.test.ts`                      | rejects one character below the minimum and accepts exactly the minimum                             | unit        |
| AUTH-06     | `tests/integration/set-password.test.ts`                  | rejects a password below the minimum before spending the link                                       | integration |
| AUTH-06     | `tests/integration/session-persistence.test.ts`           | rejects a short new password on change and on reset, without spending the reset link                | integration |
| AUTH-06     | `tests/integration/set-password.test.ts`                  | enforces the raised minimum when a link completes, and spends the link only at that minimum         | integration |
| AUTH-07     | `tests/integration/two-factor.test.ts`                    | enables an emailed code: exactly one message, and its code verifies                                 | integration |
| AUTH-07     | `tests/integration/two-factor.test.ts`                    | locks after five failures mixed across both factors and unlocks on its own                          | integration |
| AUTH-08     | `tests/integration/two-factor.test.ts`                    | enrols an authenticator app: its code verifies, a code from another secret does not                 | integration |
| AUTH-08     | `tests/unit/two-factor-gate.test.ts`                      | throws TwoFactorEnrolmentRequiredError for an unenrolled superadmin                                 | unit        |
| AUTH-09     | `tests/integration/magic-link.test.ts`                    | delivers one link to an existing user that signs them in                                            | integration |
| AUTH-09     | `tests/integration/magic-link.test.ts`                    | accepts a link just inside fifteen minutes and rejects one just past it                             | integration |
| AUTH-09     | `tests/integration/magic-link.test.ts`                    | answers an unknown address in the same shape, sends nothing and creates nobody                      | integration |
| AUTH-10     | `tests/integration/session-persistence.test.ts`           | survives a refresh: an independent instance resolves the same user from the cookie                  | integration |
| AUTH-10     | `tests/integration/session-persistence.test.ts`           | slides the expiry forward only once the update age has passed                                       | integration |
| AUTH-11     | `tests/integration/single-use.test.ts`                    | lets exactly one of two concurrent consumptions authorise                                           | integration |
| AUTH-11     | `tests/integration/single-use.test.ts`                    | keeps the token valid when the authorised action fails, and propagates its error                    | integration |
| AUTH-11     | `tests/integration/set-password.test.ts`                  | keeps the link and writes no credential when the credential write fails                             | integration |
| USER-08     | `tests/integration/audit-log.test.ts`                     | records a granted mutation with its actor, permission, entity and after state                       | integration |
| USER-08     | `tests/integration/audit-log.test.ts`                     | leaves the entity untouched when permission is denied and records the refusal                       | integration |
| USER-08     | `tests/integration/impersonation.test.ts`                 | records an action taken while impersonating with both identities on one row                         | integration |
| USER-08     | `tests/integration/impersonation.test.ts`                 | lets a host role holding users:impersonate start and stop, recording both rows                      | integration |
| USER-08     | `tests/integration/invite.test.ts`                        | writes one allowed row per invite and resend, naming the acting superadmin and no address or token  | integration |
| USER-08     | `tests/integration/set-password.test.ts`                  | writes one audit row naming the user whose credential changed                                       | integration |
| USER-08     | `tests/integration/two-factor.test.ts`                    | writes one two-factor.enabled row when an authenticator is enabled, with no secret in it            | integration |

The five Phase 2 success criteria map onto those rows: the first user holds
every permission (AUTH-01); an invited user's link works once and stops
after use or 48 hours, with a superadmin able to resend (AUTH-02, AUTH-03,
AUTH-04, AUTH-11); a user signs in with password plus second factor or with
a magic link and stays signed in across a refresh (AUTH-07, AUTH-08,
AUTH-09, AUTH-10); a reset completes through an emailed link and a password
failing the strength rule is rejected where it is set (AUTH-05, AUTH-06);
every data-changing action writes an audit record naming the acting user
(USER-08).
