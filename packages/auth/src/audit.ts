/**
 * The single permission-check-and-audit call site (USER-08, D-05, D-06).
 *
 * This is the only place an `audit_log` row is written for a
 * permission-gated mutation. Phase 3 onward routes its mutations through
 * `createAuditRecorder` (or `runAuditedMutation`) and never inserts into
 * `audit_log` itself. "Every permission-gated mutation is audited" holds
 * because no other write path exists, not because a list of audited
 * actions is kept up to date.
 *
 * The permission decision is made first. The mutation and the audit row
 * describing it then share one transaction, so either both commit or
 * neither does. There is no best-effort, fire-and-forget or
 * catch-and-continue audit write: a failed insert rolls the mutation back
 * and surfaces as `AuditWriteError`. Refusals are recorded too, with
 * `outcome` `'denied'`.
 *
 * `audit_log` is append-only. Nothing in this package updates its rows, and
 * the retention prune (`pruneAuditLog`, D-07) is the sole statement that
 * deletes from it.
 */
import type { Permission, PermissionResolver } from '@plakboek/permissions';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { redactAuditPayload } from './audit-redaction.js';
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
 * the mutation; omit it when there is none, e.g. for a creation. `after`
 * normally comes from the mutation's return value; omit both for a
 * deletion. Omitted states are stored as SQL NULL. Both pass through
 * `redactAuditPayload` before they are stored, but still prefer explicit
 * field sets over whole rows (T-02-06). */
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

/** The database itself, or an enclosing transaction (which nests as a
 * savepoint). */
export type AuditDatabase = PgDatabase<PgQueryResultHKT>;

export type AuditedMutation<T> = (
  tx: AuditTransaction,
) => Promise<{ readonly result: T; readonly after?: unknown }>;

/** Reported after an audit insert failed and its transaction rolled back.
 * Carries opaque identifiers only -- never the before/after payloads. */
export type AuditWriteFailure = {
  readonly permission: Permission;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly actorUserId: string;
  readonly occurredAt: Date;
  readonly error: AuditWriteError;
};

export type AuditFailureHook = (failure: AuditWriteFailure) => void;

export type AuditDeps = {
  readonly db: AuditDatabase;
  readonly resolver: PermissionResolver;
  /** Called exactly once per failed audit write, after the rollback.
   * Defaults to one `console.error` line. A hook that throws or rejects
   * cannot change the outcome: `AuditWriteError` is still thrown. */
  readonly onAuditWriteFailed?: AuditFailureHook;
  readonly now?: () => Date;
};

export type AuditRecorder = {
  run<T>(
    actor: AuditActor,
    entry: AuditEntryInput,
    mutation: AuditedMutation<T>,
  ): Promise<T>;
};

/** Thrown when the actor's role lacks the permission. Carries the
 * permission and role key only -- never the actor's id, email or name
 * (T-02-30). The refusal itself has already been written to the audit
 * log. */
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
 * have described was rolled back with it. The original error is `cause`. */
export class AuditWriteError extends Error {
  constructor(permission: Permission, action: string, cause: unknown) {
    super(
      `@plakboek/auth: could not write the audit entry for "${action}" (${permission}); the mutation was rolled back`,
      { cause },
    );
    this.name = 'AuditWriteError';
  }
}

const MAX_CAUSE_DEPTH = 3;

/** Error names and SQLSTATE codes along the cause chain. Messages are left
 * out on purpose: a failed Drizzle query's message quotes its parameters,
 * which here are the entity's before/after state. */
function describeCause(cause: unknown): string {
  const parts: string[] = [];
  let current = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code: unknown = Reflect.get(current, 'code');
    parts.push(
      typeof code === 'string' ? `${current.name} ${code}` : current.name,
    );
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(' <- ') : 'unknown error';
}

function defaultOnAuditWriteFailed(failure: AuditWriteFailure): void {
  // oxlint-disable-next-line no-console -- the documented default fallback hook; a host overrides `onAuditWriteFailed` to route elsewhere
  console.error(
    `[@plakboek/auth] audit write failed for "${failure.action}" (${failure.permission}) on ${failure.entityType}; the mutation was rolled back (${describeCause(failure.error.cause)})`,
  );
}

function logHookFailure(failure: AuditWriteFailure, hookError: unknown): void {
  try {
    // oxlint-disable-next-line no-console -- last-resort fallback when a host-supplied hook itself throws; nothing else can report this
    console.error(
      `[@plakboek/auth] onAuditWriteFailed hook threw while handling "${failure.action}" (${failure.permission})`,
      hookError,
    );
  } catch {
    // Never let a broken console/logger escape either.
  }
}

/** Invokes the hook once. A broken hook -- synchronous throw or rejected
 * promise -- is logged and never escalates past the caller (T-02-29). */
function reportAuditWriteFailure(
  hook: AuditFailureHook,
  failure: AuditWriteFailure,
): void {
  try {
    const returned: unknown = hook(failure);
    if (
      typeof returned === 'object' &&
      returned !== null &&
      typeof Reflect.get(returned, 'then') === 'function'
    ) {
      void Promise.resolve(returned).catch((hookError: unknown) => {
        logHookFailure(failure, hookError);
      });
    }
  } catch (hookError) {
    logHookFailure(failure, hookError);
  }
}

/** An absent state is stored as SQL NULL, not as the JSON value `null` or
 * an empty object: Drizzle binds a JavaScript `null` as SQL NULL without
 * JSON-encoding it. */
function toJsonColumn(value: unknown): unknown {
  return value ?? null;
}

type AuditOutcome<T> =
  | { readonly allowed: true; readonly result: T }
  | { readonly allowed: false };

type AuditRowInput = {
  readonly outcome: 'allowed' | 'denied';
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: Date;
};

/**
 * Checks `entry.permission` against the actor's role, then -- inside one
 * transaction -- either records the refusal and throws
 * `PermissionDeniedError` once it has committed, or runs `mutation` and
 * records its audit row next to it. A failing audit insert rolls the
 * mutation back, reports through `onAuditWriteFailed` and throws
 * `AuditWriteError`. A mutation that throws on its own rolls back and
 * writes no row, because nothing changed.
 */
export async function runAuditedMutation<T>(
  deps: AuditDeps,
  actor: AuditActor,
  entry: AuditEntryInput,
  mutation: AuditedMutation<T>,
): Promise<T> {
  const now = deps.now ?? (() => new Date());

  // The decision is made before any side effect, the same ordering the
  // resolver itself uses.
  const allowed = deps.resolver
    .resolve(actor.roleKey, { userId: actor.userId })
    .has(entry.permission);

  // Set only when this call's own insert fails, so an AuditWriteError from
  // a nested audited mutation is reported once, by the call that raised it.
  let writeFailure: AuditWriteError | undefined;

  async function writeAuditRow(
    tx: AuditTransaction,
    row: AuditRowInput,
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
        before: toJsonColumn(redactAuditPayload(row.before)),
        after: toJsonColumn(redactAuditPayload(row.after)),
        createdAt: row.createdAt,
      });
    } catch (error) {
      writeFailure = new AuditWriteError(entry.permission, entry.action, error);
      throw writeFailure;
    }
  }

  let outcome: AuditOutcome<T>;
  try {
    outcome = await deps.db.transaction(
      async (tx): Promise<AuditOutcome<T>> => {
        if (!allowed) {
          await writeAuditRow(tx, {
            outcome: 'denied',
            before: undefined,
            after: undefined,
            createdAt: now(),
          });
          return { allowed: false };
        }

        const { result, after } = await mutation(tx);
        await writeAuditRow(tx, {
          outcome: 'allowed',
          before: entry.before,
          after: after ?? entry.after,
          createdAt: now(),
        });
        return { allowed: true, result };
      },
    );
  } catch (error) {
    if (writeFailure !== undefined) {
      reportAuditWriteFailure(
        deps.onAuditWriteFailed ?? defaultOnAuditWriteFailed,
        {
          permission: entry.permission,
          action: entry.action,
          entityType: entry.entityType,
          ...(entry.entityId !== undefined ? { entityId: entry.entityId } : {}),
          actorUserId: actor.userId,
          occurredAt: now(),
          error: writeFailure,
        },
      );
    }
    throw error;
  }

  if (!outcome.allowed) {
    throw new PermissionDeniedError(entry.permission, actor.roleKey);
  }
  return outcome.result;
}

/**
 * Binds the database, resolver, failure hook and clock once, so every call
 * site only names the actor, the entry and the mutation.
 */
export function createAuditRecorder(deps: AuditDeps): AuditRecorder {
  const bound: AuditDeps = Object.freeze({ ...deps });
  return {
    run<T>(
      actor: AuditActor,
      entry: AuditEntryInput,
      mutation: AuditedMutation<T>,
    ): Promise<T> {
      return runAuditedMutation(bound, actor, entry, mutation);
    },
  };
}
