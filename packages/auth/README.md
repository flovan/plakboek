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
