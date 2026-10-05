---
'@plakboek/db': minor
---

`runMigrations` accepts optional `onLockWait` and `onMigrationStart` progress hooks. `onLockWait` fires once, the first time another migrator holds the migration lock; `onMigrationStart(name)` fires once per pending migration just before it applies, and never for an already-applied one. A hook that throws is ignored and never aborts, rolls back or reorders the run.
