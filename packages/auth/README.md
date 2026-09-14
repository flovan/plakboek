# @plakboek/auth

better-auth wiring, invite, audit and impersonation primitives for Plakboek
CMS installations: session issuance/validation, email/password with a
length-only strength rule, two-factor authentication (TOTP and email OTP),
magic links, superadmin impersonation, and the audit-log hook every
permission-gated mutation writes through.

## Install

```sh
pnpm add @plakboek/auth
```

## Status

Under active development in Phase 2 (Authentication, Sessions & Audit
Trail). The public API is not yet complete -- see this package's `src/`
for what has shipped so far.
