/**
 * Impersonation rules (D-11, D-12, D-13).
 *
 * This module is the only place the impersonation target rule lives, and the
 * only code that may call the admin plugin's impersonate API. No caller
 * reaches that API without passing through `startImpersonation`, which runs
 * this project's own target guard and the audited permission check first.
 *
 * The plugin's own gate is not what enforces D-13: its role vocabulary is
 * the plugin's, not this project's catalogue, and a guarantee that depends on
 * how that vocabulary happens to be configured is not a guarantee. The guard
 * here holds whatever the plugin is told.
 *
 * The plugin's HTTP routes for starting and stopping are closed
 * (`DISABLED_AUTH_PATHS`), so `startImpersonation` and `stopImpersonation`
 * call it server-side through `auth.api`. An impersonation ends through
 * `stopImpersonation` or lapses when the plugin's
 * `impersonationSessionDuration` (8 hours, D-12 as amended) runs out. This
 * module adds no timer, sweep or expiry logic of its own.
 */
import { eq } from 'drizzle-orm';
import type {
  AuditActor,
  AuditDatabase,
  AuditRecorder,
  AuditTransaction,
} from './audit.js';
import type { Auth } from './config.js';
import { SUPERADMIN_ROLE_KEY } from './first-user.js';
import { session as sessionTable, user as userTable } from './schema.js';

/** Why an impersonation target was refused. */
export type ImpersonationRefusalReason =
  | 'target-is-superadmin'
  | 'target-is-self';

/** Thrown when a target may not be impersonated. Carries the target's opaque
 * user id and the reason only -- never an address, display name or session
 * token. */
export class ImpersonationTargetForbiddenError extends Error {
  readonly targetUserId: string;
  readonly reason: ImpersonationRefusalReason;

  constructor(targetUserId: string, reason: ImpersonationRefusalReason) {
    super(
      `@plakboek/auth: impersonation of user "${targetUserId}" refused (${reason})`,
    );
    this.name = 'ImpersonationTargetForbiddenError';
    this.targetUserId = targetUserId;
    this.reason = reason;
  }
}

/** One side of an impersonation, as read from the user record. */
export type ImpersonationParty = {
  readonly userId: string;
  readonly roleKey: string;
};

/**
 * Returns when `actor` may impersonate `target`, and throws
 * `ImpersonationTargetForbiddenError` otherwise:
 *
 * - `target-is-self`: impersonating your own account, whatever its role.
 * - `target-is-superadmin`: D-13, a superadmin is never a target, so two
 *   equally privileged accounts can never blur into one audit trail.
 *
 * A target whose role key is unknown to the role map is allowed: an orphaned
 * role holds no permissions, so it is not a superadmin. Matching is exact.
 */
export function assertImpersonationTargetAllowed(
  target: ImpersonationParty,
  actor: ImpersonationParty,
): void {
  if (target.userId === actor.userId) {
    throw new ImpersonationTargetForbiddenError(
      target.userId,
      'target-is-self',
    );
  }
  if (target.roleKey === SUPERADMIN_ROLE_KEY) {
    throw new ImpersonationTargetForbiddenError(
      target.userId,
      'target-is-superadmin',
    );
  }
}

/** What an audit actor is derived from: the session's user id, that user's
 * stored role key, and the session's `impersonated_by` when set. */
export type ImpersonatableSession = {
  readonly userId: string;
  readonly roleKey: string;
  readonly impersonatedBy?: string;
};

/**
 * The audit actor for anything done while holding `session`. This is what
 * makes D-11's two-sided accountability hold: during an impersonation, the
 * impersonated user is recorded as the actor, because theirs are the
 * permissions being used, and the acting superadmin rides along in
 * `impersonator_user_id`, so the row names both people. Every call site
 * derives its actor here, so none can drop half of it.
 *
 * A session that claims to impersonate its own user is refused rather than
 * recorded with one identity in both columns.
 */
export function auditActorFromSession(
  session: ImpersonatableSession,
): AuditActor {
  if (session.impersonatedBy === undefined) {
    return { userId: session.userId, roleKey: session.roleKey };
  }
  if (session.impersonatedBy === session.userId) {
    throw new ImpersonationTargetForbiddenError(
      session.userId,
      'target-is-self',
    );
  }
  return {
    userId: session.userId,
    roleKey: session.roleKey,
    impersonatedBy: session.impersonatedBy,
  };
}

// ---------------------------------------------------------------------------
// Audited start and stop
// ---------------------------------------------------------------------------

/** What the audited start and stop need. `recorder` is the package's single
 * permission-check-and-audit call site; `db` reads user rows and removes a
 * minted session whose audit row could not be written. */
export type ImpersonationDeps = {
  readonly auth: Auth;
  readonly recorder: AuditRecorder;
  readonly db: AuditDatabase;
};

/** A session issued by a start or restored by a stop. `responseHeaders`
 * carries the `Set-Cookie` headers the route layer must forward to the
 * browser: the plugin's stop reads a signed `admin_session` cookie that only
 * the start sets. */
export type ImpersonationSessionResult = {
  readonly sessionToken: string;
  readonly expiresAt: Date;
  readonly responseHeaders: Headers;
};

/** Why a start or stop was refused for the state of the presented session. */
export type ImpersonationSessionRefusalReason =
  | 'no-session'
  | 'not-impersonating'
  | 'already-impersonating';

/** Thrown when the presented session cannot start or stop an impersonation:
 * there is no live session (none presented, or it has lapsed), a stop was
 * asked of a session that is not impersonating, or a start was asked of one
 * that already is. Carries the reason only. */
export class ImpersonationSessionError extends Error {
  readonly reason: ImpersonationSessionRefusalReason;

  constructor(reason: ImpersonationSessionRefusalReason) {
    super(`@plakboek/auth: impersonation refused for this session (${reason})`);
    this.name = 'ImpersonationSessionError';
    this.reason = reason;
  }
}

/** The permission every impersonation start and stop is checked against. */
const IMPERSONATE_PERMISSION = 'users:impersonate';

/** Audit actions this module records. `impersonation.refused` records a
 * start that passed the permission check and was then refused by a rule in
 * this module; its `outcome` is `'denied'` and its `after` names the
 * reason. */
const START_ACTION = 'impersonation.start';
const STOP_ACTION = 'impersonation.stop';
const REFUSED_ACTION = 'impersonation.refused';

type ResolvedSession = ImpersonatableSession & {
  readonly expiresAt: Date;
};

/**
 * Reads the session `headers` present from the session store. Refresh is
 * disabled so this read never slides an expiry, and the cookie cache is
 * bypassed so a revoked session cannot pass. A lapsed session resolves to
 * `null`, exactly like a missing one.
 */
async function resolveSession(
  auth: Auth,
  headers: Headers,
): Promise<ResolvedSession | null> {
  const found = await auth.api.getSession({
    headers,
    query: { disableRefresh: true, disableCookieCache: true },
  });
  if (found === null) {
    return null;
  }
  // Both fields come from the admin plugin's schema additions, which the
  // inferred session type does not always carry.
  const roleKey: unknown = Reflect.get(found.user, 'role');
  const impersonatedBy: unknown = Reflect.get(found.session, 'impersonatedBy');
  return {
    userId: found.user.id,
    roleKey: typeof roleKey === 'string' ? roleKey : '',
    expiresAt: new Date(found.session.expiresAt),
    ...(typeof impersonatedBy === 'string' && impersonatedBy !== ''
      ? { impersonatedBy }
      : {}),
  };
}

/** A user's stored role key, or `undefined` when the user does not exist. */
async function storedRoleKey(
  executor: AuditDatabase | AuditTransaction,
  userId: string,
): Promise<string | undefined> {
  const [row] = await executor
    .select({ roleKey: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return row === undefined ? undefined : (row.roleKey ?? '');
}

/**
 * Starts impersonating `targetUserId` as the user whose session `headers`
 * present.
 *
 * The acting identity is read from that session, the same one the plugin
 * authenticates, so the audit row and the session the plugin mints always
 * name the same person. Order of checks:
 *
 * 1. No live session: `ImpersonationSessionError('no-session')`, nothing
 *    recorded, because there is nobody to attribute it to.
 * 2. The audited permission check for `users:impersonate` (D-11). A caller
 *    without it gets one `denied` row and `PermissionDeniedError`, before
 *    anything about the target is looked at.
 * 3. This module's rules, before the plugin is reached: a session that is
 *    already impersonating cannot start another, and
 *    `assertImpersonationTargetAllowed` refuses self and superadmin targets
 *    (D-13). A refusal records an `impersonation.refused` row and rethrows.
 * 4. The plugin's `impersonateUser`, server-side. The `impersonation.start`
 *    row names the target's role key and the minted session's `expiresAt`,
 *    so a lapsed impersonation with no stop row is still reconstructable
 *    (D-12 as amended).
 *
 * The plugin writes the session through its own connection, outside the
 * audit transaction. If the audit row then fails to write, the minted
 * session is deleted before the error surfaces, so no impersonation exists
 * without its start row.
 */
export async function startImpersonation(
  deps: ImpersonationDeps,
  input: { readonly headers: Headers; readonly targetUserId: string },
): Promise<ImpersonationSessionResult> {
  const current = await resolveSession(deps.auth, input.headers);
  if (current === null) {
    throw new ImpersonationSessionError('no-session');
  }
  const actor = auditActorFromSession(current);
  const entry = {
    permission: IMPERSONATE_PERMISSION,
    entityType: 'user',
    entityId: input.targetUserId,
  } as const;

  let mintedToken: string | undefined;
  try {
    return await deps.recorder.run(
      actor,
      { ...entry, action: START_ACTION },
      async (tx) => {
        if (current.impersonatedBy !== undefined) {
          throw new ImpersonationSessionError('already-impersonating');
        }
        const targetRoleKey = await storedRoleKey(tx, input.targetUserId);
        // A missing target cannot be a superadmin; the plugin refuses it.
        assertImpersonationTargetAllowed(
          { userId: input.targetUserId, roleKey: targetRoleKey ?? '' },
          current,
        );

        const { response, headers } = await deps.auth.api.impersonateUser({
          body: { userId: input.targetUserId },
          headers: input.headers,
          returnHeaders: true,
        });
        mintedToken = response.session.token;
        const expiresAt = new Date(response.session.expiresAt);

        return {
          result: {
            sessionToken: response.session.token,
            expiresAt,
            responseHeaders: headers,
          },
          after: {
            targetRoleKey: targetRoleKey ?? '',
            expiresAt: expiresAt.toISOString(),
          },
        };
      },
    );
  } catch (error) {
    if (mintedToken !== undefined) {
      await deps.db
        .delete(sessionTable)
        .where(eq(sessionTable.token, mintedToken));
    }
    if (
      error instanceof ImpersonationTargetForbiddenError ||
      (error instanceof ImpersonationSessionError &&
        error.reason === 'already-impersonating')
    ) {
      await deps.recorder.recordDenied(actor, {
        ...entry,
        action: REFUSED_ACTION,
        after: { reason: error.reason },
      });
    }
    throw error;
  }
}

/**
 * Ends the impersonation the session `headers` present, and restores the
 * acting superadmin's own session.
 *
 * A session that is missing or has lapsed refuses with
 * `ImpersonationSessionError('no-session')`, and one that is not
 * impersonating with `'not-impersonating'`; neither writes a row. Otherwise
 * the stop runs through the audited permission check with the acting
 * superadmin as the actor, so the `impersonation.stop` row is attributed to
 * the human who ended it; its entity is the impersonated user and its
 * `before` holds the expiry the stop pre-empted.
 *
 * The plugin deletes the impersonation session through its own connection.
 * If the stop row then fails to write, the impersonation stays ended and
 * `AuditWriteError` surfaces: ending an impersonation is never undone.
 */
export async function stopImpersonation(
  deps: ImpersonationDeps,
  input: { readonly headers: Headers },
): Promise<ImpersonationSessionResult> {
  const current = await resolveSession(deps.auth, input.headers);
  if (current === null) {
    throw new ImpersonationSessionError('no-session');
  }
  if (current.impersonatedBy === undefined) {
    throw new ImpersonationSessionError('not-impersonating');
  }

  const impersonatorRoleKey =
    (await storedRoleKey(deps.db, current.impersonatedBy)) ?? '';
  const actor = auditActorFromSession({
    userId: current.impersonatedBy,
    roleKey: impersonatorRoleKey,
  });

  return await deps.recorder.run(
    actor,
    {
      permission: IMPERSONATE_PERMISSION,
      action: STOP_ACTION,
      entityType: 'user',
      entityId: current.userId,
      before: { expiresAt: current.expiresAt.toISOString() },
    },
    async () => {
      const { response, headers } = await deps.auth.api.stopImpersonating({
        headers: input.headers,
        returnHeaders: true,
      });
      return {
        result: {
          sessionToken: response.session.token,
          expiresAt: new Date(response.session.expiresAt),
          responseHeaders: headers,
        },
      };
    },
  );
}
