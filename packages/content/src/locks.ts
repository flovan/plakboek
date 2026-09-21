/**
 * Edit locking for types that enable it (TYPE-05, D-43, D-44, D-45). A lock
 * covers one locale row: `assertRowsWritable` is called with every row a
 * write touches, so a shared-field write across a translation group can
 * refuse on any one of them (plan 03-10 passes every row of the group).
 *
 * A lock is renewed by a heartbeat roughly every
 * `EDIT_LOCK_HEARTBEAT_SECONDS` and lapses after `EDIT_LOCK_TTL_SECONDS`
 * without renewal (D-43). Liveness is computed from `locked_at` at read
 * time -- there is no background sweeper or scheduled timer of any kind in
 * this module, and no admin unlock action. A lapsed lock is simply no
 * longer live; the next `acquireEditLock` or `takeOverEditLock` against it
 * succeeds as if it were unlocked.
 *
 * Acquire, renew and release write only lock bookkeeping columns -- never
 * content or `version` -- and are not audited (a 30-second heartbeat would
 * otherwise flood `audit_log`); a refused acquire is still recorded through
 * `recordDenied` because a permission refusal is always audited. Takeover is
 * different: it can interrupt someone else's work, so both an allowed and a
 * refused takeover write an `entry.lock-takeover` audit row (D-44), and a
 * successful takeover bumps `version` so the previous holder's next save
 * hits `StaleVersionError` (D-42) instead of silently overwriting the new
 * holder's work.
 */
import { PermissionDeniedError, type AuditActor } from '@plakboek/auth';
import { permissionsIncludeAll } from '@plakboek/permissions';
import { eq, sql } from 'drizzle-orm';
import type { ContentDeps } from './config.js';
import {
  EntryNotFoundError,
  getEntry,
  loadEntryForUpdate,
  toEntryRecord,
} from './entries.js';
import { contentEntries, contentTypes } from './schema.js';
import type { EntryRecord } from './types.js';

/** How often a holder is expected to renew a lock it holds (D-43). This
 * module does not enforce the interval itself -- a caller (Phase 18's
 * editor) renews on this cadence; the module only decides liveness from
 * `EDIT_LOCK_TTL_SECONDS`. */
export const EDIT_LOCK_HEARTBEAT_SECONDS = 30;

/** How long a lock stays live without a renewal before it lapses (D-43): a
 * 4x margin over the heartbeat, tolerating one or two missed beats. */
export const EDIT_LOCK_TTL_SECONDS = 120;

/** Thrown when `saveEntry`, `acquireEditLock` or `renewEditLock` finds a row
 * whose live lock is held by someone else. */
export class EntryLockedError extends Error {
  readonly entryId: string;
  readonly locale: string;
  readonly holderUserId: string;

  constructor(entryId: string, locale: string, holderUserId: string) {
    super(
      `@plakboek/content: entry "${entryId}" (${locale}) is locked by another user`,
    );
    this.name = 'EntryLockedError';
    this.entryId = entryId;
    this.locale = locale;
    this.holderUserId = holderUserId;
  }
}

/** Thrown by `acquireEditLock` when the entry's content type does not have
 * edit locking enabled. */
export class EditLockingDisabledError extends Error {
  readonly contentTypeId: string;

  constructor(contentTypeId: string) {
    super(
      `@plakboek/content: content type "${contentTypeId}" does not have edit locking enabled`,
    );
    this.name = 'EditLockingDisabledError';
    this.contentTypeId = contentTypeId;
  }
}

/** Thrown by `takeOverEditLock` when the actor's resolved permissions are
 * not a superset of the current holder's resolved permissions (D-44). */
export class LockTakeoverForbiddenError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(
      `@plakboek/content: takeover of the lock on entry "${entryId}" is forbidden`,
    );
    this.name = 'LockTakeoverForbiddenError';
    this.entryId = entryId;
  }
}

/** Thrown by `takeOverEditLock` when the lock holder changed between the
 * permission pre-check and the `FOR UPDATE` reload inside the transaction --
 * a race, not a permission problem. The caller retries. */
export class LockStateChangedError extends Error {
  readonly entryId: string;

  constructor(entryId: string) {
    super(
      `@plakboek/content: the lock on entry "${entryId}" changed while the takeover was being decided`,
    );
    this.name = 'LockStateChangedError';
    this.entryId = entryId;
  }
}

/**
 * Whether a lock naming `lockedBy`/`lockedAt` is still live at `now`: a
 * `null` holder is never live (D-43), and otherwise a lock is live for
 * strictly less than `EDIT_LOCK_TTL_SECONDS` after `lockedAt` -- live at
 * `lockedAt` plus 119999ms, lapsed at exactly `lockedAt` plus 120000ms.
 */
export function isLockLive(
  lockedBy: string | null,
  lockedAt: Date | null,
  now: Date,
): boolean {
  if (lockedBy === null || lockedAt === null) return false;
  return now.getTime() - lockedAt.getTime() < EDIT_LOCK_TTL_SECONDS * 1000;
}

/** The subset of an entry row `assertRowsWritable` needs. */
export type LockableRow = {
  readonly id: string;
  readonly locale: string;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
};

/** The subset of a content type row `assertRowsWritable` needs. */
export type LockableContentType = {
  readonly editLocking: boolean;
};

/**
 * Refuses a write on the first row (in order) holding a live lock by
 * someone other than `actorUserId` (D-45). A no-op when `type.editLocking`
 * is off -- saves on such a type ignore lock columns entirely, whatever a
 * fixture or a prior state left in them.
 */
export function assertRowsWritable(
  rows: readonly LockableRow[],
  type: LockableContentType,
  actorUserId: string,
  now: Date,
): void {
  if (!type.editLocking) return;
  for (const row of rows) {
    if (
      isLockLive(row.lockedBy, row.lockedAt, now) &&
      row.lockedBy !== actorUserId
    ) {
      // isLockLive already confirmed lockedBy is non-null.
      throw new EntryLockedError(row.id, row.locale, row.lockedBy as string);
    }
  }
}

/** Reads a user's currently stored `role_key` from `"user"` (better-auth's
 * table), or `null` when the user no longer exists. `@plakboek/auth` does
 * not export its `user` table from this package's dependency surface (see
 * `schema.ts`'s file doc comment), so the value is read as a parameterised
 * scalar subquery embedded in the select list against a dummy `FROM` --the
 * same pattern `@plakboek/auth`'s own `createUserWithRole` uses to read an
 * `EXISTS (...)` against `"user"` without importing its table. */
async function readUserRoleKey(
  db: ContentDeps['db'],
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      roleKey: sql<
        string | null
      >`(SELECT role_key FROM "user" WHERE id = ${userId})`,
    })
    .from(sql`(SELECT 1) AS "probe"`);
  return row?.roleKey ?? null;
}

async function loadEditLocking(
  db: ContentDeps['db'],
  contentTypeId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ editLocking: contentTypes.editLocking })
    .from(contentTypes)
    .where(eq(contentTypes.id, contentTypeId))
    .limit(1);
  return row?.editLocking ?? false;
}

export type AcquireEditLockInput = {
  readonly entryId: string;
};

export type EditLockGrant = {
  readonly lockedAt: Date;
  readonly expiresAt: Date;
};

/**
 * Acquires the lock on one entry locale row. Checks `entries:edit` first
 * (a refusal is recorded through `recordDenied` and throws
 * `PermissionDeniedError`, matching every other permission-gated operation
 * in this package), then -- inside one transaction -- loads and locks the
 * row (`FOR UPDATE`), refuses with `EditLockingDisabledError` when the
 * type does not have edit locking enabled, refuses with `EntryLockedError`
 * when another user already holds a live lock, and otherwise sets
 * `locked_by`/`locked_at` to the actor and now. Does not touch `version` or
 * `updated_at`.
 */
export async function acquireEditLock(
  deps: ContentDeps,
  actor: AuditActor,
  input: AcquireEditLockInput,
): Promise<EditLockGrant> {
  const permitted = deps.resolver
    .resolve(actor.roleKey, { userId: actor.userId })
    .has('entries:edit');
  if (!permitted) {
    await deps.recorder.recordDenied(actor, {
      permission: 'entries:edit',
      action: 'entry.lock-acquire',
      entityType: 'content_entry',
      entityId: input.entryId,
    });
    throw new PermissionDeniedError('entries:edit', actor.roleKey);
  }

  const now = deps.now ?? (() => new Date());

  return await deps.db.transaction(async (tx) => {
    const row = await loadEntryForUpdate(tx, deps.config, input.entryId);
    const editLocking = await loadEditLocking(tx, row.contentTypeId);
    if (!editLocking) {
      throw new EditLockingDisabledError(row.contentTypeId);
    }
    const currentTime = now();
    if (
      isLockLive(row.lockedBy, row.lockedAt, currentTime) &&
      row.lockedBy !== actor.userId
    ) {
      throw new EntryLockedError(row.id, row.locale, row.lockedBy as string);
    }

    await tx
      .update(contentEntries)
      .set({ lockedBy: actor.userId, lockedAt: currentTime })
      .where(eq(contentEntries.id, input.entryId));

    return {
      lockedAt: currentTime,
      expiresAt: new Date(currentTime.getTime() + EDIT_LOCK_TTL_SECONDS * 1000),
    };
  });
}

export type RenewEditLockInput = {
  readonly entryId: string;
};

/**
 * Renews the lock on one entry locale row: succeeds, setting `locked_at` to
 * now, when the actor currently holds it -- even if it already lapsed and
 * nobody has taken it over. Returns `false` (no-op) when nobody holds it,
 * and throws `EntryLockedError` when someone else does.
 */
export async function renewEditLock(
  deps: ContentDeps,
  actor: AuditActor,
  input: RenewEditLockInput,
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());

  return await deps.db.transaction(async (tx) => {
    const row = await loadEntryForUpdate(tx, deps.config, input.entryId);
    if (row.lockedBy === null) {
      return false;
    }
    if (row.lockedBy !== actor.userId) {
      throw new EntryLockedError(row.id, row.locale, row.lockedBy);
    }

    const currentTime = now();
    await tx
      .update(contentEntries)
      .set({ lockedAt: currentTime })
      .where(eq(contentEntries.id, input.entryId));
    return true;
  });
}

export type ReleaseEditLockInput = {
  readonly entryId: string;
};

/**
 * Releases the lock on one entry locale row when the actor currently holds
 * it, clearing both `locked_by` and `locked_at`. Returns `false`, changing
 * nothing, when nobody holds it or someone else does.
 */
export async function releaseEditLock(
  deps: ContentDeps,
  actor: AuditActor,
  input: ReleaseEditLockInput,
): Promise<boolean> {
  return await deps.db.transaction(async (tx) => {
    const row = await loadEntryForUpdate(tx, deps.config, input.entryId);
    if (row.lockedBy !== actor.userId) {
      return false;
    }

    await tx
      .update(contentEntries)
      .set({ lockedBy: null, lockedAt: null })
      .where(eq(contentEntries.id, input.entryId));
    return true;
  });
}

export type TakeOverEditLockInput = {
  readonly entryId: string;
};

const TAKEOVER_ACTION = 'entry.lock-takeover';

/**
 * Takes over the live lock on one entry locale row (D-44). When another
 * user holds a live lock, the actor's resolved permissions must be a
 * superset of that holder's *current* role's resolved permissions (read
 * fresh from `"user"`, not the role the holder had when the lock was
 * acquired) -- equal sets qualify. An orphaned holder role resolves to an
 * empty set, so any editor may take that lock over.
 *
 * The refusal decision is made before any transaction, so a refusal can be
 * recorded with `recordDenied` (`after: { reason: 'not-permission-superset'
 * }`) and `LockTakeoverForbiddenError` thrown without starting a
 * transaction that would just roll back. Otherwise the takeover runs
 * through `deps.recorder.run`, whose mutation re-reads the row `FOR UPDATE`
 * and throws `LockStateChangedError` if the holder changed since the
 * pre-check (a race, not a permission problem -- the caller retries), then
 * sets the lock to the actor and bumps `version`, so the previous holder's
 * next save from its old base version hits `StaleVersionError` (D-42).
 *
 * When nobody holds a live lock, the permission pre-check is skipped (there
 * is nobody to compare against) and the takeover proceeds like a fresh
 * acquire, still audited as `entry.lock-takeover`.
 */
export async function takeOverEditLock(
  deps: ContentDeps,
  actor: AuditActor,
  input: TakeOverEditLockInput,
): Promise<EntryRecord> {
  const now = deps.now ?? (() => new Date());
  const before = await getEntry(deps.db, input.entryId);
  if (before === null) {
    throw new EntryNotFoundError(input.entryId);
  }

  const preCheckTime = now();
  const holderIsLive = isLockLive(
    before.lockedBy,
    before.lockedAt,
    preCheckTime,
  );
  if (holderIsLive && before.lockedBy !== actor.userId) {
    const holderUserId = before.lockedBy as string;
    const holderRoleKey = await readUserRoleKey(deps.db, holderUserId);
    const allowed = permissionsIncludeAll(
      deps.resolver.resolve(actor.roleKey, { userId: actor.userId }),
      deps.resolver.resolve(holderRoleKey ?? ''),
    );
    if (!allowed) {
      await deps.recorder.recordDenied(actor, {
        permission: 'entries:edit',
        action: TAKEOVER_ACTION,
        entityType: 'content_entry',
        entityId: input.entryId,
        after: { reason: 'not-permission-superset' },
      });
      throw new LockTakeoverForbiddenError(input.entryId);
    }
  }

  return await deps.recorder.run(
    actor,
    {
      permission: 'entries:edit',
      action: TAKEOVER_ACTION,
      entityType: 'content_entry',
      entityId: input.entryId,
    },
    async (tx) => {
      const row = await loadEntryForUpdate(tx, deps.config, input.entryId);
      if (row.lockedBy !== before.lockedBy) {
        throw new LockStateChangedError(input.entryId);
      }
      const previousHolderUserId = row.lockedBy;

      const [updatedRow] = await tx
        .update(contentEntries)
        .set({
          lockedBy: actor.userId,
          lockedAt: preCheckTime,
          version: sql`${contentEntries.version} + 1`,
        })
        .where(eq(contentEntries.id, input.entryId))
        .returning();
      if (updatedRow === undefined) {
        throw new Error(
          '@plakboek/content: lock takeover update returned no row',
        );
      }
      const record = toEntryRecord(updatedRow);
      return { result: record, after: { previousHolderUserId } };
    },
  );
}
