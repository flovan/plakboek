# @plakboek/db

## 0.3.0

### Minor Changes

- [#7](https://github.com/flovan/plakboek/pull/7) [`6005d92`](https://github.com/flovan/plakboek/commit/6005d92dc7be5a9aa5a62da81201a31fe18a82ff) Thanks [@flovan](https://github.com/flovan)! - Add the 0002_content_engine migration, creating the content type, field, entry and revision tables used by @plakboek/content.

## 0.2.0

### Minor Changes

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

## 0.1.2

### Patch Changes

- [`1d784cf`](https://github.com/flovan/plakboek/commit/1d784cf0c654759215e26670ba8447ef78915a3c) Thanks [@flovan](https://github.com/flovan)! - Fix `@plakboek/db`'s README to stop documenting `withMigrationLock` as an
  importable export, guard `withMigrationLock` so a failed advisory-unlock
  query can no longer discard a successful migration result, and align both
  packages' `engines.node` floor with the workspace's own requirement.

## 0.1.1

### Patch Changes

- [#1](https://github.com/flovan/plakboek/pull/1) [`4b1b215`](https://github.com/flovan/plakboek/commit/4b1b215347e72667ac5c84a651d2de6828fd7d4e) Thanks [@flovan](https://github.com/flovan)! - Publish with npm provenance attestations from the release workflow.
