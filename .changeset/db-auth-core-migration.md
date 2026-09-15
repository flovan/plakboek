---
'@plakboek/db': minor
'@plakboek/auth': minor
---

Ship the first real migration, `0001_auth_core`, creating the authentication
tables and the append-only audit log. `@plakboek/auth` gains `createAuth`
(better-auth on the drizzle adapter with transactions enabled), the
first-user-is-superadmin rule `createUserWithRole`, the audited mutation path
`runAuditedMutation`, and the transport-agnostic `MailSender` contract.
