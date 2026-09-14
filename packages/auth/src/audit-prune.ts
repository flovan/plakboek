/**
 * Audit log retention (D-07): one exported function issuing one DELETE.
 *
 * Nothing here runs on its own. The host decides when to call
 * `pruneAuditLog` -- from a scheduled workflow, a systemd timer or a
 * database job -- so this package ships no scheduler, no queue, no job
 * table and no retry policy. This is the only statement in the package
 * that deletes from `audit_log`; every other access appends.
 */
import { lt } from 'drizzle-orm';
import type { AuditDatabase } from './audit.js';
import { auditLog } from './schema.js';

/** How long audit rows are kept, in days: one year (D-07). Rows older than
 * this are gone once a prune has run, so later compliance needs work from
 * this window rather than around it. */
export const AUDIT_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PruneAuditLogOptions = {
  /** Retention window in whole days, counted as 24-hour periods back from
   * `now()`. Defaults to `AUDIT_RETENTION_DAYS`. */
  readonly retentionDays?: number;
  readonly now?: () => Date;
};

/** Affected-row count from a Drizzle Postgres driver result: postgres-js
 * reports `count`, node-postgres reports `rowCount`. */
function deletedRowCount(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    for (const property of ['count', 'rowCount']) {
      const value: unknown = Reflect.get(result, property);
      if (typeof value === 'number') {
        return value;
      }
    }
  }
  throw new TypeError(
    '@plakboek/auth: pruneAuditLog could not read the deleted row count from the database driver',
  );
}

/**
 * Deletes every `audit_log` row created strictly before `now()` minus the
 * retention window and returns how many rows it deleted. A row exactly at
 * the cutoff is kept. The predicate is served by `audit_log_created_at_idx`.
 *
 * `retentionDays` must be a positive integer: zero, a negative, fractional
 * or non-finite value throws before any statement runs, so a bad argument
 * can never widen into deleting the whole table.
 */
export async function pruneAuditLog(
  db: AuditDatabase,
  options?: PruneAuditLogOptions,
): Promise<number> {
  const retentionDays = options?.retentionDays ?? AUDIT_RETENTION_DAYS;
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new RangeError(
      '@plakboek/auth: pruneAuditLog retentionDays must be a positive integer',
    );
  }

  const now = options?.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - retentionDays * DAY_MS);
  if (Number.isNaN(cutoff.getTime())) {
    throw new RangeError(
      '@plakboek/auth: pruneAuditLog could not compute a valid cutoff from now() and retentionDays',
    );
  }

  const result: unknown = await db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, cutoff));
  return deletedRowCount(result);
}
