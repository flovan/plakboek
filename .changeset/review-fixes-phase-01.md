---
"@plakboek/db": patch
"@plakboek/permissions": patch
---

Fix `@plakboek/db`'s README to stop documenting `withMigrationLock` as an
importable export, guard `withMigrationLock` so a failed advisory-unlock
query can no longer discard a successful migration result, and align both
packages' `engines.node` floor with the workspace's own requirement.
