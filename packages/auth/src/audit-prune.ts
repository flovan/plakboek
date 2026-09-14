/**
 * Audit log retention prune. Skeleton only: the behaviour lands with the
 * implementation commit.
 */
import type { AuditDatabase } from './audit.js';

export const AUDIT_RETENTION_DAYS = 365;

export type PruneAuditLogOptions = {
  readonly retentionDays?: number;
  readonly now?: () => Date;
};

export function pruneAuditLog(
  _db: AuditDatabase,
  _options?: PruneAuditLogOptions,
): Promise<number> {
  return Promise.resolve(0);
}
