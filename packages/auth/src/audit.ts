/**
 * The audited mutation path (USER-08, D-05, D-06). A permission-gated
 * mutation runs inside one transaction together with the audit row that
 * describes it, so either both commit or neither does -- there is no
 * best-effort audit write. Refusals are recorded too, with `outcome`
 * `'denied'`.
 */
import type { Permission, PermissionResolver } from '@plakboek/permissions';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auditLog } from './schema.js';

/** Who is acting. When a superadmin impersonates someone, `userId` and
 * `roleKey` are the impersonated user's and `impersonatedBy` is the
 * superadmin's user id (D-11). */
export type AuditActor = {
  readonly userId: string;
  readonly roleKey: string;
  readonly impersonatedBy?: string;
};

/** What is being attempted. `before` is the entity's whole state prior to
 * the mutation (omit it when there is none, e.g. a creation); `after`
 * normally comes from the mutation itself. Pass explicit field sets, never
 * whole rows that may carry password hashes or tokens (T-02-06). */
export type AuditEntryInput = {
  readonly permission: Permission;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
};

/** The transaction handle a mutation receives: every write it makes through
 * this handle commits or rolls back with the audit row. */
export type AuditTransaction = Parameters<
  Parameters<AuditDatabase['transaction']>[0]
>[0];

export type AuditDatabase = PgDatabase<PgQueryResultHKT>;

export type AuditedMutation<T> = (
  tx: AuditTransaction,
) => Promise<{ readonly result: T; readonly after?: unknown }>;

export type AuditDeps = {
  readonly db: AuditDatabase;
  readonly resolver: PermissionResolver;
  readonly now?: () => Date;
};

/** Thrown when the actor's role lacks the permission. Carries the
 * permission and role key only -- never the actor's email or name (T-02-10).
 * The refusal itself has already been written to the audit log. */
export class PermissionDeniedError extends Error {
  readonly permission: Permission;
  readonly roleKey: string;

  constructor(permission: Permission, roleKey: string) {
    super(
      `@plakboek/auth: role "${roleKey}" does not hold permission "${permission}"`,
    );
    this.name = 'PermissionDeniedError';
    this.permission = permission;
    this.roleKey = roleKey;
  }
}

/** Thrown when the audit row could not be written. The mutation it would
 * have described was rolled back with it. The database error is `cause`. */
export class AuditWriteError extends Error {
  constructor(permission: Permission, action: string, cause: unknown) {
    super(
      `@plakboek/auth: could not write the audit entry for "${action}" (${permission}); the mutation was rolled back`,
      { cause },
    );
    this.name = 'AuditWriteError';
  }
}

type AuditOutcome<T> =
  | { readonly allowed: true; readonly result: T }
  | { readonly allowed: false };

/**
 * Checks `entry.permission` against the actor's role, then -- inside one
 * transaction -- either records the refusal and throws
 * `PermissionDeniedError` after it commits, or runs `mutation` and records
 * its audit row. A failing audit insert rolls the mutation back and
 * surfaces as `AuditWriteError`.
 */
export async function runAuditedMutation<T>(
  deps: AuditDeps,
  actor: AuditActor,
  entry: AuditEntryInput,
  mutation: AuditedMutation<T>,
): Promise<T> {
  const now = deps.now ?? (() => new Date());

  const outcome = await deps.db.transaction(
    async (tx): Promise<AuditOutcome<T>> => {
      const granted = deps.resolver.resolve(actor.roleKey, {
        userId: actor.userId,
      });

      if (!granted.has(entry.permission)) {
        await insertAuditRow(tx, actor, entry, {
          outcome: 'denied',
          after: undefined,
          createdAt: now(),
        });
        return { allowed: false };
      }

      const { result, after } = await mutation(tx);
      await insertAuditRow(tx, actor, entry, {
        outcome: 'allowed',
        after: after ?? entry.after,
        createdAt: now(),
      });
      return { allowed: true, result };
    },
  );

  if (!outcome.allowed) {
    throw new PermissionDeniedError(entry.permission, actor.roleKey);
  }
  return outcome.result;
}

/** An absent state is stored as SQL NULL, not as the JSON value `null`:
 * Drizzle binds a JavaScript `null` as SQL NULL without JSON-encoding it. */
function toJsonColumn(value: unknown): unknown {
  return value === undefined ? null : value;
}

async function insertAuditRow(
  tx: AuditTransaction,
  actor: AuditActor,
  entry: AuditEntryInput,
  row: {
    readonly outcome: 'allowed' | 'denied';
    readonly after: unknown;
    readonly createdAt: Date;
  },
): Promise<void> {
  try {
    await tx.insert(auditLog).values({
      actorUserId: actor.userId,
      actorRoleKey: actor.roleKey,
      impersonatorUserId: actor.impersonatedBy ?? null,
      permission: entry.permission,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      outcome: row.outcome,
      before: toJsonColumn(entry.before),
      after: toJsonColumn(row.after),
      createdAt: row.createdAt,
    });
  } catch (error) {
    throw new AuditWriteError(entry.permission, entry.action, error);
  }
}
