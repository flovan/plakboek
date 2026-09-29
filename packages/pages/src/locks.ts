/**
 * Page+locale edit locking (D-39, D-41, mirrors `@plakboek/content`'s
 * `locks.ts` -- 03 D-43, D-44, D-45): the same mechanism Phase 3 gave
 * entries, unchanged -- the same ~30s heartbeat, the same ~120s TTL, the
 * same superset takeover re-derived against the holder's freshly-read role,
 * the same in-transaction liveness re-derivation at the TTL boundary -- at
 * page+locale granularity. A `pages` row already carries its own `locale`,
 * so page+locale granularity needs no extra key: the `en` and `nl` rows of
 * one translation group are separate lockable rows, so two translators work
 * in parallel (D-39).
 *
 * The one genuine difference from the entry lock: the enable flag is a
 * single project-wide setting (`page_engine_settings.page_edit_locking`,
 * D-40), not a per-content-type column, read here through
 * `getPageEditLocking` rather than a per-row join.
 *
 * Acquire, renew and release write only lock bookkeeping columns -- never
 * `version` or `updated_at` -- and their success is not audited (a
 * 30-second heartbeat would otherwise flood `audit_log`); a refused
 * attempt at any of the three is still recorded through `recordDenied`,
 * since a permission refusal is always audited. Takeover is different: it
 * can interrupt someone else's work, so both an allowed and a refused
 * takeover write a `page.lock-takeover` audit row, and a successful
 * takeover bumps `version` so the previous holder's next write hits
 * `StalePageVersionError` (D-42) instead of silently overwriting the new
 * holder's work.
 *
 * This module intentionally does not import from `pages.ts`: `pages.ts`
 * itself needs `assertPageWritable`/`getPageEditLocking` for `renamePage`/
 * `movePage`, and a `pages.ts <-> locks.ts` cycle is exactly the class of
 * problem this package has already hit once (`pages.ts <-> tree.ts`,
 * resolved by relocating `StalePageVersionError`) -- so this module loads
 * and writes the `pages` row itself, directly against the schema.
 */
import {
  PermissionDeniedError,
  type AuditActor,
  type AuditTransaction,
} from '@plakboek/auth';
import { permissionsIncludeAll } from '@plakboek/permissions';
import { eq, sql } from 'drizzle-orm';
import type { PagesDeps } from './config.js';
import { pages } from './schema.js';
import { getPageEditLocking } from './settings.js';

/** How often a holder is expected to renew a lock it holds. This module
 * does not enforce the interval itself -- a caller (Phase 18's editor)
 * renews on this cadence; the module only decides liveness from
 * `PAGE_EDIT_LOCK_TTL_SECONDS`. Matches `@plakboek/content`'s
 * `EDIT_LOCK_HEARTBEAT_SECONDS` exactly (D-39: the mechanism is reused
 * unchanged) -- a unit test compares the two constants so a future change
 * to one is caught. */
export const PAGE_EDIT_LOCK_HEARTBEAT_SECONDS = 30;

/** How long a lock stays live without a renewal before it lapses: a 4x
 * margin over the heartbeat, tolerating one or two missed beats. Matches
 * `@plakboek/content`'s `EDIT_LOCK_TTL_SECONDS` exactly (D-39). */
export const PAGE_EDIT_LOCK_TTL_SECONDS = 120;

/** Thrown by a write path's `assertPageWritable` call, or by
 * `acquirePageLock`/`renewPageLock`, when a page row's live lock is held by
 * someone else. */
export class PageLockedError extends Error {
  readonly pageId: string;
  readonly locale: string;
  readonly holderUserId: string;

  constructor(pageId: string, locale: string, holderUserId: string) {
    super(
      `@plakboek/pages: page "${pageId}" (${locale}) is locked by another user`,
    );
    this.name = 'PageLockedError';
    this.pageId = pageId;
    this.locale = locale;
    this.holderUserId = holderUserId;
  }
}

/** Thrown by `acquirePageLock` when the project-wide page edit-lock toggle
 * (D-40) is off -- acquiring a lock nothing will honour would be worse than
 * refusing outright. */
export class PageLockingDisabledError extends Error {
  constructor() {
    super('@plakboek/pages: page edit locking is disabled for this project');
    this.name = 'PageLockingDisabledError';
  }
}

/** Thrown by `takeOverPageLock` when the actor's resolved permissions are
 * not a superset of the current holder's resolved permissions (D-44,
 * mirrors `@plakboek/content`'s `LockTakeoverForbiddenError`). */
export class PageLockTakeoverForbiddenError extends Error {
  readonly pageId: string;

  constructor(pageId: string) {
    super(
      `@plakboek/pages: takeover of the lock on page "${pageId}" is forbidden`,
    );
    this.name = 'PageLockTakeoverForbiddenError';
    this.pageId = pageId;
  }
}

/** Thrown by `takeOverPageLock` when the lock holder's identity or role
 * changed between the permission pre-check and the `FOR UPDATE` reload
 * inside the transaction -- a race, not a permission problem. The caller
 * retries, which re-runs the pre-check against the now-current holder.
 * Mirrors `@plakboek/content`'s `LockStateChangedError`. */
export class PageLockStateChangedError extends Error {
  readonly pageId: string;

  constructor(pageId: string) {
    super(
      `@plakboek/pages: the lock on page "${pageId}" changed while the takeover was being decided`,
    );
    this.name = 'PageLockStateChangedError';
    this.pageId = pageId;
  }
}

/**
 * Whether a lock naming `lockedBy`/`lockedAt` is still live at `now`: a
 * `null` holder is never live, and otherwise a lock is live for strictly
 * less than `PAGE_EDIT_LOCK_TTL_SECONDS` after `lockedAt` -- live at
 * `lockedAt` plus 119999ms, lapsed at exactly `lockedAt` plus 120000ms.
 */
export function isPageLockLive(
  lockedBy: string | null,
  lockedAt: Date | null,
  now: Date,
): boolean {
  if (lockedBy === null || lockedAt === null) return false;
  return now.getTime() - lockedAt.getTime() < PAGE_EDIT_LOCK_TTL_SECONDS * 1000;
}

/** The subset of a page row `assertPageWritable` needs. `PageRecord`
 * (`types.ts`) is a superset of this shape, so every already-loaded page
 * row in this package's write paths is passable here directly. */
export type LockablePageRow = {
  readonly id: string;
  readonly locale: string;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
};

/**
 * Refuses a write on the first row (in order) holding a live lock by
 * someone other than `actorUserId`. A no-op when `pageEditLocking` is
 * `false` -- every write path ignores lock columns entirely whenever the
 * project-wide toggle is off, whatever a fixture or a prior state left in
 * them (mirrors `@plakboek/content`'s `assertRowsWritable`, 03 D-43).
 * Called with a single-row list for a page-scoped write (`renamePage`,
 * `movePage`, `insertBlock`, `moveBlock`, `deleteBlock`, `updateBlockProps`,
 * every `lifecycle.ts` transition, `materialisePublication`) and with a
 * whole subtree's rows for `trashPage`/`deletePagePermanently`, so a
 * colleague's live lock on any one descendant refuses the whole operation.
 */
export function assertPageWritable(
  rows: readonly LockablePageRow[],
  pageEditLocking: boolean,
  actorUserId: string,
  now: Date,
): void {
  if (!pageEditLocking) return;
  for (const row of rows) {
    if (
      isPageLockLive(row.lockedBy, row.lockedAt, now) &&
      row.lockedBy !== actorUserId
    ) {
      // isPageLockLive already confirmed lockedBy is non-null.
      throw new PageLockedError(row.id, row.locale, row.lockedBy as string);
    }
  }
}

/** Reads a user's currently stored `role_key` from `"user"` (better-auth's
 * table), or `null` when the user no longer exists. `@plakboek/auth` does
 * not export its `user` table from this package's dependency surface, so
 * the value is read as a parameterised scalar subquery embedded in the
 * select list against a dummy `FROM` -- the same technique
 * `@plakboek/content`'s `locks.ts` uses. */
async function readUserRoleKey(
  db: PagesDeps['db'] | AuditTransaction,
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

/** Loads and locks (`FOR UPDATE`) one `pages` row by id, throwing
 * `PageLockNotFoundError` when it doesn't exist. Package-private: every
 * exported function here is the audited (or denied-audited) entry point, so
 * a caller reaching this directly could lock a page row outside any of
 * them. */
async function lockPageRow(
  tx: AuditTransaction,
  pageId: string,
): Promise<{
  readonly id: string;
  readonly locale: string;
  readonly version: number;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
}> {
  const [row] = await tx
    .select({
      id: pages.id,
      locale: pages.locale,
      version: pages.version,
      lockedBy: pages.lockedBy,
      lockedAt: pages.lockedAt,
    })
    .from(pages)
    .where(eq(pages.id, pageId))
    .for('update');
  if (row === undefined) {
    throw new PageLockNotFoundError(pageId);
  }
  return row;
}

/** Thrown when a lock operation (`acquirePageLock`, `renewPageLock`,
 * `releasePageLock`, `takeOverPageLock`) names a `pageId` that no longer
 * exists. Distinct from `pages.ts`'s `PageNotFoundError` on purpose (see
 * this module's own header comment): importing that class here would
 * re-introduce the `pages.ts <-> locks.ts` cycle this module is written to
 * avoid. */
export class PageLockNotFoundError extends Error {
  readonly pageId: string;

  constructor(pageId: string) {
    super(`@plakboek/pages: no page found for id "${pageId}"`);
    this.name = 'PageLockNotFoundError';
    this.pageId = pageId;
  }
}

export type AcquirePageLockInput = {
  readonly pageId: string;
};

export type PageLockGrant = {
  readonly lockedAt: Date;
  readonly expiresAt: Date;
};

/**
 * Acquires the lock on one page locale row -- the "open" call (D-41): a
 * lock is taken when an editor opens a page, not implied by any write.
 * Checks `pages:edit` first (a refusal is recorded through `recordDenied`
 * and throws `PermissionDeniedError`), then -- inside one transaction --
 * loads and locks the row (`FOR UPDATE`), refuses with
 * `PageLockingDisabledError` when the project-wide toggle is off, refuses
 * with `PageLockedError` when another user already holds a live lock, and
 * otherwise sets `locked_by`/`locked_at` to the actor and now. Does not
 * touch `version` or `updated_at`: taking a lock is not an edit.
 */
export async function acquirePageLock(
  deps: PagesDeps,
  actor: AuditActor,
  input: AcquirePageLockInput,
): Promise<PageLockGrant> {
  const permitted = deps.resolver
    .resolve(actor.roleKey, { userId: actor.userId })
    .has('pages:edit');
  if (!permitted) {
    await deps.recorder.recordDenied(actor, {
      permission: 'pages:edit',
      action: 'page.lock-acquire',
      entityType: 'page',
      entityId: input.pageId,
    });
    throw new PermissionDeniedError('pages:edit', actor.roleKey);
  }

  const now = deps.now ?? (() => new Date());

  return await deps.db.transaction(async (tx) => {
    const row = await lockPageRow(tx, input.pageId);
    const pageEditLocking = await getPageEditLocking(tx);
    if (!pageEditLocking) {
      throw new PageLockingDisabledError();
    }
    const currentTime = now();
    if (
      isPageLockLive(row.lockedBy, row.lockedAt, currentTime) &&
      row.lockedBy !== actor.userId
    ) {
      throw new PageLockedError(row.id, row.locale, row.lockedBy as string);
    }

    await tx
      .update(pages)
      .set({ lockedBy: actor.userId, lockedAt: currentTime })
      .where(eq(pages.id, input.pageId));

    return {
      lockedAt: currentTime,
      expiresAt: new Date(
        currentTime.getTime() + PAGE_EDIT_LOCK_TTL_SECONDS * 1000,
      ),
    };
  });
}

export type RenewPageLockInput = {
  readonly pageId: string;
};

/**
 * Renews the lock on one page locale row -- the heartbeat call: succeeds,
 * setting `locked_at` to now, when the actor currently holds it, even if it
 * already lapsed and nobody has taken it over. Checks `pages:edit` first,
 * matching `acquirePageLock`'s own refusal shape. Returns `false` (no-op)
 * when nobody holds it, and throws `PageLockedError` when someone else
 * does.
 */
export async function renewPageLock(
  deps: PagesDeps,
  actor: AuditActor,
  input: RenewPageLockInput,
): Promise<boolean> {
  const permitted = deps.resolver
    .resolve(actor.roleKey, { userId: actor.userId })
    .has('pages:edit');
  if (!permitted) {
    await deps.recorder.recordDenied(actor, {
      permission: 'pages:edit',
      action: 'page.lock-renew',
      entityType: 'page',
      entityId: input.pageId,
    });
    throw new PermissionDeniedError('pages:edit', actor.roleKey);
  }

  const now = deps.now ?? (() => new Date());

  return await deps.db.transaction(async (tx) => {
    const row = await lockPageRow(tx, input.pageId);
    if (row.lockedBy === null) {
      return false;
    }
    if (row.lockedBy !== actor.userId) {
      throw new PageLockedError(row.id, row.locale, row.lockedBy);
    }

    const currentTime = now();
    await tx
      .update(pages)
      .set({ lockedAt: currentTime })
      .where(eq(pages.id, input.pageId));
    return true;
  });
}

export type ReleasePageLockInput = {
  readonly pageId: string;
};

/**
 * Releases the lock on one page locale row -- the navigate-away call
 * (D-41) -- when the actor currently holds it, clearing both `locked_by`
 * and `locked_at`. Checks `pages:edit` first, matching `acquirePageLock`'s
 * own refusal shape. Returns `false`, changing nothing, when nobody holds
 * it or someone else does.
 */
export async function releasePageLock(
  deps: PagesDeps,
  actor: AuditActor,
  input: ReleasePageLockInput,
): Promise<boolean> {
  const permitted = deps.resolver
    .resolve(actor.roleKey, { userId: actor.userId })
    .has('pages:edit');
  if (!permitted) {
    await deps.recorder.recordDenied(actor, {
      permission: 'pages:edit',
      action: 'page.lock-release',
      entityType: 'page',
      entityId: input.pageId,
    });
    throw new PermissionDeniedError('pages:edit', actor.roleKey);
  }

  return await deps.db.transaction(async (tx) => {
    const row = await lockPageRow(tx, input.pageId);
    if (row.lockedBy !== actor.userId) {
      return false;
    }

    await tx
      .update(pages)
      .set({ lockedBy: null, lockedAt: null })
      .where(eq(pages.id, input.pageId));
    return true;
  });
}

export type TakeOverPageLockInput = {
  readonly pageId: string;
};

/** The lock's shape on a page row -- what `takeOverPageLock` returns.
 * Deliberately narrower than the full `PageRecord` (`types.ts`): a takeover
 * touches only these columns, and returning the whole record could mislead
 * a caller into treating untouched columns (title, slug, seo, ...) as
 * fresh. */
export type PageLockState = {
  readonly id: string;
  readonly locale: string;
  readonly version: number;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
};

const TAKEOVER_ACTION = 'page.lock-takeover';

/**
 * Takes over the live lock on one page locale row (D-44). When another
 * user holds a live lock, the actor's resolved permissions must be a
 * superset of that holder's *current* role's resolved permissions (read
 * fresh from `"user"`, not the role the holder had when the lock was
 * acquired) -- equal sets qualify. An orphaned holder role resolves to an
 * empty set, so any editor may take that lock over.
 *
 * The refusal decision is made before any transaction, so a refusal can be
 * recorded with `recordDenied` (`after: { reason: 'not-permission-superset'
 * }`) and `PageLockTakeoverForbiddenError` thrown without starting a
 * transaction that would just roll back. Otherwise the takeover runs
 * through `deps.recorder.run` (`pages:edit` / `page.lock-takeover`), whose
 * mutation re-reads the row `FOR UPDATE` and throws
 * `PageLockStateChangedError` if the holder changed since the pre-check (a
 * race, not a permission problem -- the caller retries). The mutation also
 * re-derives liveness against the reloaded row and its own clock read, and
 * refuses the same way when a holder that looked lapsed at pre-check
 * time -- and so was never compared against the D-44 superset rule -- is
 * live again by the time the row is locked: the pre-check's decision to
 * skip that comparison has gone stale, and a retry re-runs it against the
 * now-live holder. Otherwise the mutation sets the lock to the actor and
 * bumps `version`, so the previous holder's next write from its old base
 * version hits `StalePageVersionError` (D-42).
 *
 * When nobody holds a live lock, the permission pre-check is skipped (there
 * is nobody to compare against) and the takeover proceeds like a fresh
 * acquire, still audited as `page.lock-takeover`.
 */
export async function takeOverPageLock(
  deps: PagesDeps,
  actor: AuditActor,
  input: TakeOverPageLockInput,
): Promise<PageLockState> {
  const now = deps.now ?? (() => new Date());
  const [before] = await deps.db
    .select({
      id: pages.id,
      locale: pages.locale,
      version: pages.version,
      lockedBy: pages.lockedBy,
      lockedAt: pages.lockedAt,
    })
    .from(pages)
    .where(eq(pages.id, input.pageId))
    .limit(1);
  if (before === undefined) {
    throw new PageLockNotFoundError(input.pageId);
  }

  const preCheckTime = now();
  const holderIsLive = isPageLockLive(
    before.lockedBy,
    before.lockedAt,
    preCheckTime,
  );
  let preCheckHolderRoleKey: string | null = null;
  if (holderIsLive && before.lockedBy !== actor.userId) {
    const holderUserId = before.lockedBy as string;
    const holderRoleKey = await readUserRoleKey(deps.db, holderUserId);
    preCheckHolderRoleKey = holderRoleKey;
    const allowed = permissionsIncludeAll(
      deps.resolver.resolve(actor.roleKey, { userId: actor.userId }),
      deps.resolver.resolve(holderRoleKey ?? ''),
    );
    if (!allowed) {
      await deps.recorder.recordDenied(actor, {
        permission: 'pages:edit',
        action: TAKEOVER_ACTION,
        entityType: 'page',
        entityId: input.pageId,
        after: { reason: 'not-permission-superset' },
      });
      throw new PageLockTakeoverForbiddenError(input.pageId);
    }
  }

  return await deps.recorder.run(
    actor,
    {
      permission: 'pages:edit',
      action: TAKEOVER_ACTION,
      entityType: 'page',
      entityId: input.pageId,
    },
    async (tx) => {
      const row = await lockPageRow(tx, input.pageId);
      if (row.lockedBy !== before.lockedBy) {
        throw new PageLockStateChangedError(input.pageId);
      }
      const transactionTime = now();
      const holderStillLive = isPageLockLive(
        row.lockedBy,
        row.lockedAt,
        transactionTime,
      );
      // D-44: the holder's identity is re-checked above, but the superset
      // comparison ran before this transaction against the holder's role at
      // that moment. A role change since then makes that decision stale, so
      // refuse and let the caller retry, which re-runs the comparison
      // against the current role. Same shape as the liveness re-check
      // below, and it keeps recordDenied on its single write path.
      if (
        holderIsLive &&
        holderStillLive &&
        row.lockedBy !== null &&
        row.lockedBy !== actor.userId
      ) {
        const currentHolderRoleKey = await readUserRoleKey(tx, row.lockedBy);
        if (currentHolderRoleKey !== preCheckHolderRoleKey) {
          throw new PageLockStateChangedError(input.pageId);
        }
      }

      if (holderStillLive && !holderIsLive && row.lockedBy !== actor.userId) {
        // The pre-check saw a lapsed lock and skipped the D-44 superset
        // comparison, but the holder renewed before this reload -- the skip
        // decision has gone stale. Refuse rather than displace a live
        // holder whose permissions were never compared; the caller retries
        // and the pre-check re-runs the comparison against the live holder.
        throw new PageLockStateChangedError(input.pageId);
      }
      const previousHolderUserId = row.lockedBy;

      const [updatedRow] = await tx
        .update(pages)
        .set({
          lockedBy: actor.userId,
          lockedAt: transactionTime,
          version: sql`${pages.version} + 1`,
        })
        .where(eq(pages.id, input.pageId))
        .returning({
          id: pages.id,
          locale: pages.locale,
          version: pages.version,
          lockedBy: pages.lockedBy,
          lockedAt: pages.lockedAt,
        });
      if (updatedRow === undefined) {
        throw new Error(
          '@plakboek/pages: page lock takeover update returned no row',
        );
      }
      return { result: updatedRow, after: { previousHolderUserId } };
    },
  );
}
