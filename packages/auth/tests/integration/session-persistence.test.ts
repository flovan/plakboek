import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/config.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { createTestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'session-test-secret-with-at-least-32-characters';
const PASSWORD = 'correct horse battery staple';
const SESSION_COOKIE = 'better-auth.session_token';
const THIRTY_DAYS_MS = 2592000 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TOLERANCE_MS = 5000;

const roles = defineRoles(defaultRoles);

type Fixture = {
  readonly auth: Auth;
  readonly handle: Db;
  readonly mail: MailSender & { readonly sent: MailMessage[] };
  openSecondInstance(): Auth;
};

function recordingMailSender(): MailSender & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

/** Runs `body` against a freshly migrated database that is dropped after. */
async function withFixture(body: (fixture: Fixture) => Promise<void>) {
  const testDatabase = await createTestDatabase();
  const handles: Db[] = [];
  try {
    const { connectionString } = testDatabase;
    await runMigrations({ connectionString });
    const handle = createDb({ connectionString });
    handles.push(handle);
    const mail = recordingMailSender();
    const auth = createAuth({
      db: handle.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail,
      roles,
    });
    await body({
      auth,
      handle,
      mail,
      openSecondInstance() {
        const second = createDb({ connectionString });
        handles.push(second);
        return createAuth({
          db: second.db,
          baseURL: BASE_URL,
          secret: SECRET,
          mail: recordingMailSender(),
          roles,
        });
      },
    });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await testDatabase.drop();
  }
}

/** Creates a user with an email-and-password credential through
 * better-auth's own hashing and adapter. */
async function createPasswordUser(
  fixture: Fixture,
  email: string,
): Promise<string> {
  const created = await createUserWithRole(fixture.handle.db, {
    id: randomUUID(),
    email,
    name: email,
    roleKey: 'editor',
  });
  const context = await fixture.auth.$context;
  await context.internalAdapter.linkAccount({
    userId: created.userId,
    providerId: 'credential',
    accountId: created.userId,
    password: await context.password.hash(PASSWORD),
  });
  return created.userId;
}

function cookieValue(headers: Headers, name: string): string | undefined {
  for (const cookie of headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && separator > 0) {
      if (pair.slice(0, separator) === name) {
        return pair.slice(separator + 1);
      }
    }
  }
  return undefined;
}

function cookieNames(headers: Headers): string[] {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split('=')[0] ?? '')
    .toSorted((a, b) => a.localeCompare(b));
}

async function signIn(auth: Auth, email: string) {
  const result = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = cookieValue(result.headers, SESSION_COOKIE);
  expect(cookie).toBeDefined();
  return {
    response: result.response,
    headers: result.headers,
    cookieHeader: new Headers({ cookie: `${SESSION_COOKIE}=${cookie ?? ''}` }),
  };
}

/** The stored `expires_at` of one session, in epoch milliseconds. */
async function storedExpiry(handle: Db, token: string): Promise<number> {
  const [row] = await handle.sql<{ expiresAtMs: number }[]>`
    SELECT (extract(epoch FROM expires_at) * 1000)::float8 AS "expiresAtMs"
    FROM session WHERE token = ${token}
  `;
  expect(row).toBeDefined();
  return row?.expiresAtMs ?? 0;
}

describe('session persistence (AUTH-10, D-01, D-02)', () => {
  it('survives a refresh: an independent instance resolves the same user from the cookie', async () => {
    await withFixture(async (fixture) => {
      const userId = await createPasswordUser(fixture, 'ada@example.com');
      const { response, cookieHeader } = await signIn(
        fixture.auth,
        'ada@example.com',
      );

      const refreshed = await fixture
        .openSecondInstance()
        .api.getSession({ headers: cookieHeader });

      expect(refreshed?.user.id).toBe(userId);
      expect(refreshed?.session.token).toBe(response.token);
      expect(refreshed?.session.expiresAt.getTime()).toBeGreaterThan(
        Date.now(),
      );
    });
  });

  it('issues a session that expires thirty days after sign-in', async () => {
    await withFixture(async (fixture) => {
      await createPasswordUser(fixture, 'ada@example.com');
      const before = Date.now();
      const { response } = await signIn(fixture.auth, 'ada@example.com');
      const after = Date.now();

      const expiresAt = await storedExpiry(fixture.handle, response.token);

      expect(expiresAt).toBeGreaterThanOrEqual(
        before + THIRTY_DAYS_MS - TOLERANCE_MS,
      );
      expect(expiresAt).toBeLessThanOrEqual(
        after + THIRTY_DAYS_MS + TOLERANCE_MS,
      );
    });
  });

  it('slides the expiry forward only once the update age has passed', async () => {
    await withFixture(async (fixture) => {
      await createPasswordUser(fixture, 'ada@example.com');
      const { response, cookieHeader } = await signIn(
        fixture.auth,
        'ada@example.com',
      );

      // Inside the update-age window: resolving leaves the expiry alone.
      const issued = await storedExpiry(fixture.handle, response.token);
      const early = await fixture.auth.api.getSession({
        headers: cookieHeader,
      });
      expect(early?.session.token).toBe(response.token);
      expect(await storedExpiry(fixture.handle, response.token)).toBe(issued);

      // Make the session look 25 hours old -- past the one-day update age.
      await fixture.handle.sql`
        UPDATE session
        SET expires_at = expires_at - interval '25 hours',
            created_at = created_at - interval '25 hours',
            updated_at = updated_at - interval '25 hours'
        WHERE token = ${response.token}
      `;
      const aged = await storedExpiry(fixture.handle, response.token);

      const beforeResolve = Date.now();
      const late = await fixture.auth.api.getSession({
        headers: cookieHeader,
      });
      expect(late?.session.token).toBe(response.token);

      const slid = await storedExpiry(fixture.handle, response.token);
      expect(slid).toBeGreaterThan(aged + ONE_HOUR_MS);
      expect(slid).toBeGreaterThanOrEqual(
        beforeResolve + THIRTY_DAYS_MS - TOLERANCE_MS,
      );
    });
  });

  it('no longer resolves a session whose expiry has passed', async () => {
    await withFixture(async (fixture) => {
      await createPasswordUser(fixture, 'ada@example.com');
      const { response, cookieHeader } = await signIn(
        fixture.auth,
        'ada@example.com',
      );
      await fixture.handle.sql`
        UPDATE session SET expires_at = now() - interval '1 second'
        WHERE token = ${response.token}
      `;

      const resolved = await fixture.auth.api.getSession({
        headers: cookieHeader,
      });

      expect(resolved).toBeNull();
    });
  });

  it('keeps every concurrent session live: three sign-ins, three sessions, no eviction', async () => {
    await withFixture(async (fixture) => {
      const userId = await createPasswordUser(fixture, 'ada@example.com');
      const devices = [];
      for (let device = 0; device < 3; device += 1) {
        devices.push(await signIn(fixture.auth, 'ada@example.com'));
      }

      const tokens = devices.map((device) => device.response.token);
      expect(new Set(tokens).size).toBe(3);

      const [stored] = await fixture.handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM session WHERE user_id = ${userId}
      `;
      expect(stored?.count).toBe(3);

      for (const device of devices) {
        const resolved = await fixture.auth.api.getSession({
          headers: device.cookieHeader,
        });
        expect(resolved?.user.id).toBe(userId);
        expect(resolved?.session.token).toBe(device.response.token);
      }
    });
  });

  it('exposes exactly one session credential, with no refresh token to rotate', async () => {
    await withFixture(async (fixture) => {
      const userId = await createPasswordUser(fixture, 'ada@example.com');
      const { response, headers } = await signIn(
        fixture.auth,
        'ada@example.com',
      );

      expect(cookieNames(headers)).toEqual([SESSION_COOKIE]);
      expect(Object.keys(response).filter((key) => /token/i.test(key))).toEqual(
        ['token'],
      );

      const sessionColumns = await fixture.handle.sql<{ name: string }[]>`
        SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session'
          AND column_name LIKE '%token%'
      `;
      expect(sessionColumns.map((column) => column.name)).toEqual(['token']);

      const credentials = await fixture.handle.sql<
        { refreshToken: string | null; accessToken: string | null }[]
      >`
        SELECT refresh_token AS "refreshToken", access_token AS "accessToken"
        FROM account WHERE user_id = ${userId}
      `;
      expect(credentials).toEqual([{ refreshToken: null, accessToken: null }]);
    });
  });
});

describe("password policy on better-auth's own credential paths (AUTH-06, D-08)", () => {
  /** Twelve UTF-16 code units, six code points. */
  const SIX_EMOJI = '\u{1F510}'.repeat(6);
  const ELEVEN = 'a'.repeat(11);

  it('rejects a short password at sign-up and accepts one at the minimum', async () => {
    await withFixture(async (fixture) => {
      for (const password of [ELEVEN, SIX_EMOJI]) {
        await expect(
          fixture.auth.api.signUpEmail({
            body: { email: 'new@example.com', name: 'New', password },
          }),
        ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } });
      }
      const [none] = await fixture.handle.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM "user"
      `;
      expect(none?.count).toBe(0);

      const created = await fixture.auth.api.signUpEmail({
        body: {
          email: 'new@example.com',
          name: 'New',
          password: 'a'.repeat(12),
        },
      });
      expect(created.user.email).toBe('new@example.com');
    });
  });

  it('rejects a short new password on change and on reset, without spending the reset link', async () => {
    await withFixture(async (fixture) => {
      await createPasswordUser(fixture, 'ada@example.com');
      const { cookieHeader } = await signIn(fixture.auth, 'ada@example.com');

      await expect(
        fixture.auth.api.changePassword({
          body: { currentPassword: PASSWORD, newPassword: SIX_EMOJI },
          headers: cookieHeader,
        }),
      ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } });

      await fixture.auth.api.requestPasswordReset({
        body: { email: 'ada@example.com' },
      });
      // The reset send is dispatched without being awaited (D-15).
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(fixture.mail.sent).toHaveLength(1);
      const token = /reset-password\/([A-Za-z0-9]+)/.exec(
        fixture.mail.sent[0]?.text ?? '',
      )?.[1];
      expect(token).toBeDefined();

      for (const newPassword of [ELEVEN, SIX_EMOJI]) {
        await expect(
          fixture.auth.api.resetPassword({
            body: { token: token ?? '', newPassword },
          }),
        ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } });
      }

      const reset = await fixture.auth.api.resetPassword({
        body: { token: token ?? '', newPassword: 'b'.repeat(12) },
      });
      expect(reset.status).toBe(true);
    });
  });
});
