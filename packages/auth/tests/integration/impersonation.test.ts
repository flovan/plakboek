import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
} from '@plakboek/permissions';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditWriteError,
  PermissionDeniedError,
  createAuditRecorder,
  type AuditRecorder,
} from '../../src/audit.js';
import {
  IMPERSONATION_SESSION_TTL_SECONDS,
  SESSION_EXPIRES_IN_SECONDS,
  createAuth,
  type Auth,
} from '../../src/config.js';
import { createUserWithRole } from '../../src/first-user.js';
import {
  ImpersonationSessionError,
  ImpersonationTargetForbiddenError,
  auditActorFromSession,
  startImpersonation,
  stopImpersonation,
  type ImpersonatableSession,
  type ImpersonationDeps,
} from '../../src/impersonation.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'impersonation-test-secret-with-at-least-32-characters';
const PASSWORD = 'correct horse battery staple';
const TOLERANCE_MS = 5000;

/** The shipped roles plus one host role that holds `users:impersonate`
 * without being superadmin, so a nested start can pass the permission
 * check and prove this module's own refusal. */
const roles = defineRoles({
  ...defaultRoles,
  delegate: ['users:read', 'users:impersonate'],
});

type Person = {
  readonly userId: string;
  readonly email: string;
};

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly auth: Auth;
  readonly recorder: AuditRecorder;
  readonly deps: ImpersonationDeps;
  readonly owner: Person;
  readonly otherOwner: Person;
  readonly editor: Person;
  readonly admin: Person;
  readonly delegate: Person;
};

type StoredAuditRow = {
  readonly actorUserId: string | null;
  readonly actorRoleKey: string;
  readonly impersonatorUserId: string | null;
  readonly permission: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly outcome: string;
  readonly beforeIsNull: boolean;
  readonly afterIsNull: boolean;
  readonly before: unknown;
  readonly after: unknown;
};

type StoredSession = {
  readonly userId: string;
  readonly impersonatedBy: string | null;
  readonly expiresAtMs: number;
};

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

/** Creates a user with a password credential through the server-side path.
 * The first user created in a database becomes the superadmin. */
async function createPerson(
  handle: Db,
  auth: Auth,
  name: string,
  roleKey: string,
): Promise<Person> {
  const email = `${name}@example.com`;
  const created = await createUserWithRole(handle.db, {
    id: randomUUID(),
    email,
    name,
    roleKey,
  });
  expect(created.roleKey).toBe(roleKey);
  const context = await auth.$context;
  await context.internalAdapter.linkAccount({
    userId: created.userId,
    providerId: 'credential',
    accountId: created.userId,
    password: await context.password.hash(PASSWORD),
  });
  return { userId: created.userId, email };
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    const { connectionString } = testDatabase;
    await runMigrations({ connectionString });
    const handle = createDb({ connectionString });
    const auth = createAuth({
      db: handle.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail: { send: () => Promise.resolve() },
      roles,
    });
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver: createPermissionResolver(roles),
    });
    current = {
      testDatabase,
      handle,
      auth,
      recorder,
      deps: { auth, recorder, db: handle.db },
      owner: await createPerson(handle, auth, 'owner', 'superadmin'),
      otherOwner: await createPerson(handle, auth, 'other-owner', 'superadmin'),
      editor: await createPerson(handle, auth, 'editor', 'editor'),
      admin: await createPerson(handle, auth, 'admin', 'admin'),
      delegate: await createPerson(handle, auth, 'delegate', 'delegate'),
    };
  } catch (error) {
    await testDatabase.drop();
    throw error;
  }
});

afterEach(async () => {
  const finished = current;
  current = undefined;
  if (finished !== undefined) {
    await finished.handle.close();
    await finished.testDatabase.drop();
  }
});

/**
 * A browser's cookie jar for one tab: every `Set-Cookie` a response carries
 * is applied, an emptied cookie is removed, and `headers()` sends them all
 * back, as a browser would.
 */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  apply(headers: Headers): this {
    for (const setCookie of headers.getSetCookie()) {
      const pair = setCookie.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = /;\s*max-age=0\b/i.test(setCookie);
      if (value === '' || expired) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
    return this;
  }

  /** The request headers a browser would send; `omit` leaves one cookie
   * out, as a client that dropped it would. */
  headers(omit?: string): Headers {
    return new Headers({
      cookie: [...this.#cookies]
        .filter(([name]) => name !== omit)
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    });
  }

  /** Request headers carrying one cookie and nothing else, as a client that
   * kept only that cookie would send. */
  only(name: string): Headers {
    const value = this.#cookies.get(name);
    if (value === undefined) {
      throw new Error(`the cookie jar holds no ${name} cookie`);
    }
    return new Headers({ cookie: `${name}=${value}` });
  }
}

const SESSION_COOKIE = 'better-auth.session_token';

async function signedIn(person: Person): Promise<CookieJar> {
  const { headers } = await fixture().auth.api.signInEmail({
    body: { email: person.email, password: PASSWORD },
    returnHeaders: true,
  });
  return new CookieJar().apply(headers);
}

async function auditRows(): Promise<StoredAuditRow[]> {
  const rows = await fixture().handle.sql<StoredAuditRow[]>`
    SELECT actor_user_id AS "actorUserId", actor_role_key AS "actorRoleKey",
           impersonator_user_id AS "impersonatorUserId", permission, action,
           entity_type AS "entityType", entity_id AS "entityId", outcome,
           before IS NULL AS "beforeIsNull", after IS NULL AS "afterIsNull",
           before, after
    FROM audit_log ORDER BY id
  `;
  return [...rows];
}

async function sessionByToken(
  token: string,
): Promise<StoredSession | undefined> {
  const [row] = await fixture().handle.sql<StoredSession[]>`
    SELECT user_id AS "userId", impersonated_by AS "impersonatedBy",
           (extract(epoch FROM expires_at) * 1000)::float8 AS "expiresAtMs"
    FROM session WHERE token = ${token}
  `;
  return row;
}

async function impersonatedSessionCount(): Promise<number> {
  const [row] = await fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM session WHERE impersonated_by IS NOT NULL
  `;
  return row?.count ?? -1;
}

async function sessionCount(): Promise<number> {
  const [row] = await fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM session
  `;
  return row?.count ?? -1;
}

/** The session a request carrying `jar` resolves to, in the shape the
 * audit actor is derived from. */
async function sessionOf(
  jar: CookieJar,
): Promise<ImpersonatableSession | null> {
  const found = await fixture().auth.api.getSession({ headers: jar.headers() });
  if (found === null) return null;
  const roleKey: unknown = Reflect.get(found.user, 'role');
  const impersonatedBy: unknown = Reflect.get(found.session, 'impersonatedBy');
  return {
    userId: found.user.id,
    roleKey: typeof roleKey === 'string' ? roleKey : '',
    ...(typeof impersonatedBy === 'string' ? { impersonatedBy } : {}),
  };
}

async function refusal<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  return caught as T;
}

/** Starts an impersonation of `target` from `owner`'s signed-in tab and
 * returns that tab with the impersonation cookies applied. */
async function impersonate(target: Person) {
  const { deps, owner } = fixture();
  const jar = await signedIn(owner);
  const result = await startImpersonation(deps, {
    headers: jar.headers(),
    targetUserId: target.userId,
  });
  jar.apply(result.responseHeaders);
  return { jar, result };
}

describe('audited impersonation start and stop (D-11, D-12)', () => {
  it('starts: a session impersonated by the superadmin, and one allowed impersonation.start row', async () => {
    const { owner, editor } = fixture();
    const { result } = await impersonate(editor);

    const stored = await sessionByToken(result.sessionToken);
    expect(stored?.userId).toBe(editor.userId);
    expect(stored?.impersonatedBy).toBe(owner.userId);

    expect(await auditRows()).toEqual([
      {
        actorUserId: owner.userId,
        actorRoleKey: 'superadmin',
        impersonatorUserId: null,
        permission: 'users:impersonate',
        action: 'impersonation.start',
        entityType: 'user',
        entityId: editor.userId,
        outcome: 'allowed',
        beforeIsNull: true,
        afterIsNull: false,
        before: null,
        after: {
          targetRoleKey: 'editor',
          expiresAt: result.expiresAt.toISOString(),
        },
      },
    ]);
  });

  it('records an action taken while impersonating with both identities on one row', async () => {
    const { owner, editor, recorder } = fixture();
    const { jar } = await impersonate(editor);

    const held = await sessionOf(jar);
    expect(held).not.toBeNull();
    await recorder.run(
      auditActorFromSession(held ?? { userId: '', roleKey: '' }),
      {
        permission: 'pages:edit',
        action: 'page.edit',
        entityType: 'page',
        entityId: 'page-1',
        before: { title: 'Old' },
      },
      async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return { result: undefined, after: { title: 'New' } };
      },
    );

    const edit = (await auditRows()).filter(
      (row) => row.action === 'page.edit',
    );
    expect(edit).toHaveLength(1);
    expect(edit[0]).toMatchObject({
      actorUserId: editor.userId,
      actorRoleKey: 'editor',
      impersonatorUserId: owner.userId,
      outcome: 'allowed',
    });
  });

  it("stops: a second row for impersonation.stop, and the restored session is the superadmin's own", async () => {
    const { owner, editor, deps } = fixture();
    const { jar, result: started } = await impersonate(editor);

    const stopped = await stopImpersonation(deps, { headers: jar.headers() });
    jar.apply(stopped.responseHeaders);

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      'impersonation.start',
      'impersonation.stop',
    ]);
    expect(rows[1]).toEqual({
      actorUserId: owner.userId,
      actorRoleKey: 'superadmin',
      impersonatorUserId: null,
      permission: 'users:impersonate',
      action: 'impersonation.stop',
      entityType: 'user',
      entityId: editor.userId,
      outcome: 'allowed',
      beforeIsNull: false,
      afterIsNull: true,
      before: { expiresAt: started.expiresAt.toISOString() },
      after: null,
    });

    expect(await sessionByToken(started.sessionToken)).toBeUndefined();
    const restored = await sessionByToken(stopped.sessionToken);
    expect(restored?.userId).toBe(owner.userId);
    expect(restored?.impersonatedBy).toBeNull();

    const resolved = await sessionOf(jar);
    expect(resolved).toEqual({ userId: owner.userId, roleKey: 'superadmin' });
  });

  it('lapses eight hours after issue, earlier than a normal session, at the expiresAt on the start row', async () => {
    const { owner, editor } = fixture();
    const ownerJar = await signedIn(owner);
    const ownerSession = await fixture().auth.api.getSession({
      headers: ownerJar.headers(),
    });

    const issuedFrom = Date.now();
    const { jar, result } = await impersonate(editor);
    const issuedUntil = Date.now();

    const stored = await sessionByToken(result.sessionToken);
    const expiresAtMs = stored?.expiresAtMs ?? Number.NaN;
    expect(expiresAtMs).toBeGreaterThanOrEqual(
      issuedFrom + 28800 * 1000 - TOLERANCE_MS,
    );
    expect(expiresAtMs).toBeLessThanOrEqual(
      issuedUntil + IMPERSONATION_SESSION_TTL_SECONDS * 1000 + TOLERANCE_MS,
    );

    const normal = await sessionByToken(ownerSession?.session.token ?? '');
    expect(normal?.expiresAtMs).toBeGreaterThanOrEqual(
      issuedFrom + SESSION_EXPIRES_IN_SECONDS * 1000 - TOLERANCE_MS,
    );
    expect(expiresAtMs).toBeLessThan(normal?.expiresAtMs ?? 0);

    const [start] = await auditRows();
    const recorded = (start?.after as { expiresAt?: string } | undefined)
      ?.expiresAt;
    expect(Date.parse(recorded ?? '')).toBe(expiresAtMs);
    expect(result.expiresAt.getTime()).toBe(expiresAtMs);

    // Reading the session the way a browser presents it does not move it.
    expect((await sessionOf(jar))?.impersonatedBy).toBe(owner.userId);
    expect((await sessionByToken(result.sessionToken))?.expiresAtMs).toBe(
      expiresAtMs,
    );
  });

  it('once past its expiry, the token no longer resolves and stop refuses without a stop row', async () => {
    const { editor, deps, handle } = fixture();
    const { jar, result } = await impersonate(editor);

    // Time is advanced by back-dating the stored instants, the way the other
    // integration suites prove expiry, rather than by faking the clock.
    await handle.sql`
      UPDATE session
      SET expires_at = expires_at - interval '8 hours 1 second',
          created_at = created_at - interval '8 hours 1 second',
          updated_at = updated_at - interval '8 hours 1 second'
      WHERE token = ${result.sessionToken}
    `;

    expect(await sessionOf(jar)).toBeNull();

    const error = await refusal(
      stopImpersonation(deps, { headers: jar.headers() }),
      ImpersonationSessionError,
    );
    expect(error.reason).toBe('no-session');
    expect((await auditRows()).map((row) => row.action)).toEqual([
      'impersonation.start',
    ]);
  });

  it('refuses to stop a session that is not impersonating, writing nothing', async () => {
    const { owner, deps } = fixture();
    const jar = await signedIn(owner);

    const error = await refusal(
      stopImpersonation(deps, { headers: jar.headers() }),
      ImpersonationSessionError,
    );
    expect(error.reason).toBe('not-impersonating');
    expect(await auditRows()).toEqual([]);
  });
});

describe('an impersonation expiry cannot be extended (D-12, D-01)', () => {
  /**
   * better-auth refreshes a session on read once
   * `expires_at - SESSION_EXPIRES_IN_SECONDS + SESSION_UPDATE_AGE_SECONDS`
   * is in the past, which an 8-hour session satisfies from the moment it is
   * issued. `updated_at` is back-dated past the update age as well, so the
   * read is a refresh whichever of the two instants decides it.
   */
  async function agedImpersonation(target: Person) {
    const { handle } = fixture();
    const issuedFrom = Date.now();
    const { jar, result } = await impersonate(target);
    const issuedUntil = Date.now();
    await handle.sql`
      UPDATE session SET updated_at = updated_at - interval '25 hours'
      WHERE token = ${result.sessionToken}
    `;
    const issued = (await sessionByToken(result.sessionToken))?.expiresAtMs;
    expect(issued).toBeGreaterThanOrEqual(
      issuedFrom + IMPERSONATION_SESSION_TTL_SECONDS * 1000 - TOLERANCE_MS,
    );
    expect(issued).toBeLessThanOrEqual(
      issuedUntil + IMPERSONATION_SESSION_TTL_SECONDS * 1000 + TOLERANCE_MS,
    );
    return { jar, result, issued: issued ?? Number.NaN };
  }

  it('keeps expires_at at issue + 8 hours when read with only the session token cookie', async () => {
    const { owner, editor, auth } = fixture();
    const { jar, result, issued } = await agedImpersonation(editor);

    const found = await auth.api.getSession({
      headers: jar.only(SESSION_COOKIE),
    });

    expect(found?.user.id).toBe(editor.userId);
    expect(Reflect.get(found?.session ?? {}, 'impersonatedBy')).toBe(
      owner.userId,
    );
    expect((await sessionByToken(result.sessionToken))?.expiresAtMs).toBe(
      issued,
    );
    expect(found?.session.expiresAt.getTime()).toBe(issued);
  });

  it('keeps expires_at at issue + 8 hours when read with the full cookie set', async () => {
    const { editor, auth } = fixture();
    const { jar, result, issued } = await agedImpersonation(editor);

    const found = await auth.api.getSession({ headers: jar.headers() });

    expect(found?.user.id).toBe(editor.userId);
    expect((await sessionByToken(result.sessionToken))?.expiresAtMs).toBe(
      issued,
    );
  });

  it('keeps expires_at at issue + 8 hours when a protected endpoint reads the session', async () => {
    const { editor, auth } = fixture();
    const { jar, result, issued } = await agedImpersonation(editor);

    // The endpoint's session middleware rejects an unauthenticated request,
    // so resolving proves the impersonation session was read. The admin
    // plugin leaves impersonation sessions out of the list itself.
    await expect(
      auth.api.listSessions({ headers: jar.only(SESSION_COOKIE) }),
    ).resolves.toBeInstanceOf(Array);

    expect((await sessionByToken(result.sessionToken))?.expiresAtMs).toBe(
      issued,
    );
  });

  it('still slides a normal session to thirty days when read the same way', async () => {
    const { owner, auth, handle } = fixture();
    const jar = await signedIn(owner);
    const own = await auth.api.getSession({ headers: jar.headers() });
    const token = own?.session.token ?? '';

    // Past the one-day update age, the way session-persistence proves D-01.
    await handle.sql`
      UPDATE session
      SET expires_at = expires_at - interval '25 hours',
          created_at = created_at - interval '25 hours',
          updated_at = updated_at - interval '25 hours'
      WHERE token = ${token}
    `;
    const aged = (await sessionByToken(token))?.expiresAtMs ?? Number.NaN;

    const readFrom = Date.now();
    await auth.api.getSession({ headers: jar.only(SESSION_COOKIE) });
    const readUntil = Date.now();

    const slid = (await sessionByToken(token))?.expiresAtMs ?? Number.NaN;
    expect(slid).toBeGreaterThan(aged);
    expect(slid).toBeGreaterThanOrEqual(
      readFrom + SESSION_EXPIRES_IN_SECONDS * 1000 - TOLERANCE_MS,
    );
    expect(slid).toBeLessThanOrEqual(
      readUntil + SESSION_EXPIRES_IN_SECONDS * 1000 + TOLERANCE_MS,
    );
  });
});

describe('impersonation refusals (D-11, D-13)', () => {
  it('refuses a superadmin target before any session exists, and records the attempt', async () => {
    const { owner, otherOwner, deps } = fixture();
    const jar = await signedIn(owner);
    const sessionsBefore = await sessionCount();

    const error = await refusal(
      startImpersonation(deps, {
        headers: jar.headers(),
        targetUserId: otherOwner.userId,
      }),
      ImpersonationTargetForbiddenError,
    );
    expect(error.reason).toBe('target-is-superadmin');

    expect(await impersonatedSessionCount()).toBe(0);
    expect(await sessionCount()).toBe(sessionsBefore);

    const rows = await auditRows();
    expect(rows.filter((row) => row.action === 'impersonation.start')).toEqual(
      [],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        actorUserId: owner.userId,
        actorRoleKey: 'superadmin',
        impersonatorUserId: null,
        permission: 'users:impersonate',
        action: 'impersonation.refused',
        entityType: 'user',
        entityId: otherOwner.userId,
        after: { reason: 'target-is-superadmin' },
      }),
    ]);
  });

  it('refuses a user without users:impersonate: no session and one denied row', async () => {
    const { editor, admin, deps } = fixture();
    const jar = await signedIn(editor);
    const sessionsBefore = await sessionCount();

    await refusal(
      startImpersonation(deps, {
        headers: jar.headers(),
        targetUserId: admin.userId,
      }),
      PermissionDeniedError,
    );

    expect(await impersonatedSessionCount()).toBe(0);
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        actorUserId: editor.userId,
        actorRoleKey: 'editor',
        permission: 'users:impersonate',
        action: 'impersonation.start',
        entityId: admin.userId,
        outcome: 'denied',
        beforeIsNull: true,
        afterIsNull: true,
      }),
    ]);
  });

  it('checks the permission before the target, so a refused caller learns nothing about who is a superadmin', async () => {
    const { editor, owner, deps } = fixture();
    const jar = await signedIn(editor);

    await refusal(
      startImpersonation(deps, {
        headers: jar.headers(),
        targetUserId: owner.userId,
      }),
      PermissionDeniedError,
    );

    expect(await impersonatedSessionCount()).toBe(0);
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        actorUserId: editor.userId,
        action: 'impersonation.start',
        outcome: 'denied',
      }),
    ]);
  });

  it('refuses to start from a session that is already impersonating, naming both people', async () => {
    const { owner, delegate, editor, deps } = fixture();
    const { jar } = await impersonate(delegate);

    const error = await refusal(
      startImpersonation(deps, {
        headers: jar.headers(),
        targetUserId: editor.userId,
      }),
      ImpersonationSessionError,
    );
    expect(error.reason).toBe('already-impersonating');

    expect(await impersonatedSessionCount()).toBe(1);
    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      'impersonation.start',
      'impersonation.refused',
    ]);
    expect(rows[1]).toMatchObject({
      actorUserId: delegate.userId,
      actorRoleKey: 'delegate',
      impersonatorUserId: owner.userId,
      entityId: editor.userId,
      after: { reason: 'already-impersonating' },
    });
  });

  it('never slides the impersonation expiry while reading the session, even without the dont_remember cookie', async () => {
    const { delegate, editor, deps } = fixture();
    const { jar, result } = await impersonate(delegate);
    const issued = (await sessionByToken(result.sessionToken))?.expiresAtMs;
    expect(issued).toBeDefined();

    // better-auth slides any session read without its dont_remember cookie
    // unless refresh is disabled; this module's own reads disable it.
    await refusal(
      startImpersonation(deps, {
        headers: jar.headers('better-auth.dont_remember'),
        targetUserId: editor.userId,
      }),
      ImpersonationSessionError,
    );

    expect((await sessionByToken(result.sessionToken))?.expiresAtMs).toBe(
      issued,
    );
  });

  it('refuses a request with no session, writing nothing', async () => {
    const { editor, deps } = fixture();

    const error = await refusal(
      startImpersonation(deps, {
        headers: new Headers(),
        targetUserId: editor.userId,
      }),
      ImpersonationSessionError,
    );
    expect(error.reason).toBe('no-session');
    expect(await auditRows()).toEqual([]);
    expect(await impersonatedSessionCount()).toBe(0);
  });

  it('deletes the minted session when its start row cannot be written', async () => {
    const { owner, editor, auth, handle } = fixture();
    const failures: unknown[] = [];
    const brokenRecorder = createAuditRecorder({
      db: handle.db,
      resolver: createPermissionResolver(roles),
      // An invalid instant makes the audit insert itself fail.
      now: () => new Date(Number.NaN),
      onAuditWriteFailed: (failure) => {
        failures.push(failure.action);
      },
    });
    const jar = await signedIn(owner);

    await refusal(
      startImpersonation(
        { auth, recorder: brokenRecorder, db: handle.db },
        { headers: jar.headers(), targetUserId: editor.userId },
      ),
      AuditWriteError,
    );

    expect(failures).toEqual(['impersonation.start']);
    expect(await impersonatedSessionCount()).toBe(0);
    expect(await auditRows()).toEqual([]);
    expect((await sessionOf(jar))?.userId).toBe(owner.userId);
  });
});
