# @plakboek/auth

## 0.2.0

### Minor Changes

- [#5](https://github.com/flovan/plakboek/pull/5) [`ce0eee8`](https://github.com/flovan/plakboek/commit/ce0eee88e0c2fae714490ea7d1814b3741f198fe) Thanks [@flovan](https://github.com/flovan)! - Add the @plakboek/auth package scaffold with its real-Postgres integration
  test harness and the length-only password strength rule (AUTH-06).

- [#5](https://github.com/flovan/plakboek/pull/5) [`ebe8ef3`](https://github.com/flovan/plakboek/commit/ebe8ef3863c2918807cb4e960428f978d26ca827) Thanks [@flovan](https://github.com/flovan)! - Complete the authentication surface: sessions, two-factor sign-in, magic
  links, invitations, single-use password links, audited impersonation, SMTP
  mail delivery and the audit log with its retention prune are exported from
  `@plakboek/auth`, and every better-auth admin-plugin HTTP route is closed.
  `@plakboek/db` ships the migration those features run on.

- [#5](https://github.com/flovan/plakboek/pull/5) [`53889d6`](https://github.com/flovan/plakboek/commit/53889d64944e36ca41e459e223d1dc70f583e19b) Thanks [@flovan](https://github.com/flovan)! - Ship the first real migration, `0001_auth_core`, creating the authentication
  tables and the append-only audit log. `@plakboek/auth` gains `createAuth`
  (better-auth on the drizzle adapter with transactions enabled), the
  first-user-is-superadmin rule `createUserWithRole`, the audited mutation path
  `runAuditedMutation`, and the transport-agnostic `MailSender` contract.

### Patch Changes

- Updated dependencies [[`ebe8ef3`](https://github.com/flovan/plakboek/commit/ebe8ef3863c2918807cb4e960428f978d26ca827), [`53889d6`](https://github.com/flovan/plakboek/commit/53889d64944e36ca41e459e223d1dc70f583e19b)]:
  - @plakboek/db@0.2.0
  - @plakboek/permissions@0.2.0
