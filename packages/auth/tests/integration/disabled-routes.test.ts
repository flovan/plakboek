import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/config.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { createTestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const AUTH_URL = `${BASE_URL}/api/auth`;
const SECRET = 'disabled-routes-test-secret-with-at-least-32-characters';
const PASSWORD = 'correct horse battery staple';
const SESSION_COOKIE = 'better-auth.session_token';
const EIGHT_HOURS_MS = 28800 * 1000;
const TOLERANCE_MS = 5000;
const OWNER = 'owner@example.com';
const EDITOR = 'ada@example.com';

const roles = defineRoles(defaultRoles);

type RecordingSender = MailSender & { readonly sent: MailMessage[] };

type Fixture = {
  readonly auth: Auth;
  readonly handle: Db;
  readonly mail: RecordingSender;
};

function recordingMailSender(): RecordingSender {
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
    await body({ auth, handle, mail });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await testDatabase.drop();
  }
}

/** Creates a user with a password credential through the server-side path
 * only. The first user created in a database becomes the superadmin. */
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

/** The `name=value` pair of one non-empty cookie a response sets. */
function cookiePair(headers: Headers, name: string): string {
  const pair = headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .find(
      (candidate) =>
        candidate.startsWith(`${name}=`) && candidate.length > name.length + 1,
    );
  expect(pair).toBeDefined();
  return pair ?? '';
}

function sessionCookieOf(headers: Headers): string {
  return cookiePair(headers, SESSION_COOKIE);
}

/** Lets every detached promise chain settle: the magic-link send is
 * dispatched without being awaited (D-15). */
async function flushDetached(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

type StoredVerification = {
  readonly identifier: string;
  readonly value: string;
};

async function storedVerifications(handle: Db): Promise<StoredVerification[]> {
  return [
    ...(await handle.sql<StoredVerification[]>`
      SELECT identifier, value FROM verification
    `),
  ];
}

/** Asserts no stored verification row holds `secret` in any form that
 * contains it verbatim. */
function expectNotAtRest(rows: StoredVerification[], secret: string): void {
  expect(secret.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.identifier).not.toContain(secret);
    expect(row.value).not.toContain(secret);
  }
}

async function signedInCookie(auth: Auth, email: string): Promise<string> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return sessionCookieOf(headers);
}

type RowCounts = {
  readonly users: number;
  readonly sessions: number;
  readonly verifications: number;
  readonly accounts: number;
};

async function rowCounts(handle: Db): Promise<RowCounts> {
  const [row] = await handle.sql<RowCounts[]>`
    SELECT (SELECT count(*)::int FROM "user") AS users,
           (SELECT count(*)::int FROM session) AS sessions,
           (SELECT count(*)::int FROM verification) AS verifications,
           (SELECT count(*)::int FROM account) AS accounts
  `;
  expect(row).toBeDefined();
  return row ?? { users: -1, sessions: -1, verifications: -1, accounts: -1 };
}

type ClosedRoute = {
  /** The path as better-auth registers it. */
  readonly route: string;
  readonly method: 'GET' | 'POST';
  /** A concrete path for the route, before any variant is applied. */
  readonly path: string;
  readonly query?: string;
  readonly body?: (ids: { readonly editorId: string }) => unknown;
};

/**
 * One request per closed route, written out here rather than read from
 * `DISABLED_AUTH_PATHS`, so dropping a path from the constant fails its
 * case. Each request is one the open route would act on: a valid sign-up,
 * a superadmin impersonating a real editor, a reset for a real address.
 */
const CLOSED_ROUTES: readonly ClosedRoute[] = [
  {
    route: '/sign-up/email',
    method: 'POST',
    path: '/sign-up/email',
    body: () => ({ email: 'new@example.com', name: 'New', password: PASSWORD }),
  },
  {
    route: '/admin/impersonate-user',
    method: 'POST',
    path: '/admin/impersonate-user',
    body: ({ editorId }) => ({ userId: editorId }),
  },
  {
    route: '/admin/stop-impersonating',
    method: 'POST',
    path: '/admin/stop-impersonating',
    body: () => ({}),
  },
  {
    route: '/request-password-reset',
    method: 'POST',
    path: '/request-password-reset',
    body: () => ({ email: EDITOR }),
  },
  {
    route: '/reset-password',
    method: 'POST',
    path: '/reset-password',
    body: () => ({ token: 'not-a-token', newPassword: 'b'.repeat(12) }),
  },
  {
    route: '/reset-password/:token',
    method: 'GET',
    path: '/reset-password/not-a-token',
    query: 'callbackURL=%2F',
  },
];

/** Spellings of one path a lax matcher might let through. */
function variantsOf(route: ClosedRoute): { name: string; url: string }[] {
  const query = route.query === undefined ? '' : `?${route.query}`;
  const withProbe = route.query === undefined ? '?probe=1' : `${query}&probe=1`;
  const lastChar = route.path.at(-1) ?? '';
  const encodedLast = `%${lastChar.charCodeAt(0).toString(16).toUpperCase()}`;
  return [
    { name: 'exact', url: `${AUTH_URL}${route.path}${query}` },
    { name: 'trailing slash', url: `${AUTH_URL}${route.path}/${query}` },
    { name: 'two trailing slashes', url: `${AUTH_URL}${route.path}//${query}` },
    { name: 'query string', url: `${AUTH_URL}${route.path}${withProbe}` },
    {
      name: 'upper case',
      url: `${AUTH_URL}${route.path.toUpperCase()}${query}`,
    },
    {
      name: 'percent-encoded last character',
      url: `${AUTH_URL}${route.path.slice(0, -1)}${encodedLast}${query}`,
    },
  ];
}

describe('closed better-auth HTTP routes', () => {
  it.each(CLOSED_ROUTES)(
    'answers $method $route with 404 in every spelling, and changes nothing',
    async (route) => {
      await withFixture(async (fixture) => {
        const { auth, handle, mail } = fixture;
        await createPasswordUser(fixture, OWNER);
        const editorId = await createPasswordUser(fixture, EDITOR);
        const cookie = await signedInCookie(auth, OWNER);
        const before = await rowCounts(handle);

        for (const variant of variantsOf(route)) {
          const response = await auth.handler(
            new Request(variant.url, {
              method: route.method,
              headers: {
                cookie,
                origin: BASE_URL,
                ...(route.body === undefined
                  ? {}
                  : { 'content-type': 'application/json' }),
              },
              ...(route.body === undefined
                ? {}
                : { body: JSON.stringify(route.body({ editorId })) }),
            }),
          );
          expect({ variant: variant.name, status: response.status }).toEqual({
            variant: variant.name,
            status: 404,
          });
        }

        expect(await rowCounts(handle)).toEqual(before);
        expect(mail.sent).toEqual([]);
      });
    },
  );

  it('still lets a superadmin impersonate through auth.api, for eight hours', async () => {
    await withFixture(async (fixture) => {
      const { auth, handle } = fixture;
      const ownerId = await createPasswordUser(fixture, OWNER);
      const editorId = await createPasswordUser(fixture, EDITOR);
      const cookie = await signedInCookie(auth, OWNER);

      const before = Date.now();
      const impersonation = await auth.api.impersonateUser({
        body: { userId: editorId },
        headers: new Headers({ cookie }),
      });
      const after = Date.now();

      const [row] = await handle.sql<
        { userId: string; impersonatedBy: string | null; expiresAtMs: number }[]
      >`
        SELECT user_id AS "userId", impersonated_by AS "impersonatedBy",
               (extract(epoch FROM expires_at) * 1000)::float8 AS "expiresAtMs"
        FROM session WHERE token = ${impersonation.session.token}
      `;
      expect(row?.userId).toBe(editorId);
      expect(row?.impersonatedBy).toBe(ownerId);
      expect(row?.expiresAtMs).toBeGreaterThanOrEqual(
        before + EIGHT_HOURS_MS - TOLERANCE_MS,
      );
      expect(row?.expiresAtMs).toBeLessThanOrEqual(
        after + EIGHT_HOURS_MS + TOLERANCE_MS,
      );
    });
  });

  it('still signs a server-created user in with email and password over HTTP', async () => {
    await withFixture(async (fixture) => {
      const { auth } = fixture;
      const userId = await createPasswordUser(fixture, OWNER);

      const response = await auth.handler(
        new Request(`${AUTH_URL}/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({ email: OWNER, password: PASSWORD }),
        }),
      );
      expect(response.status).toBe(200);

      const session = await auth.api.getSession({
        headers: new Headers({ cookie: sessionCookieOf(response.headers) }),
      });
      expect(session?.user.id).toBe(userId);
    });
  });
});

describe('one-time credentials are hashed at rest', () => {
  it('stores a magic link without its token, and the delivered link still signs in', async () => {
    await withFixture(async (fixture) => {
      const { auth, handle, mail } = fixture;
      const userId = await createPasswordUser(fixture, OWNER);

      await auth.api.signInMagicLink({
        body: { email: OWNER },
        headers: new Headers(),
      });
      await flushDetached();
      expect(mail.sent).toHaveLength(1);
      const link =
        /https?:\/\/\S*magic-link\/verify\S*/.exec(mail.sent[0]?.text ?? '')?.[0] ??
        '';
      const token = new URL(link).searchParams.get('token') ?? '';

      const rows = await storedVerifications(handle);
      expect(rows.filter((row) => row.value.includes(OWNER))).toHaveLength(1);
      expectNotAtRest(rows, token);

      const response = await auth.handler(new Request(link));
      expect(response.status).toBe(302);
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: sessionCookieOf(response.headers) }),
      });
      expect(session?.user.id).toBe(userId);
    });
  });

  it('stores an emailed second-factor code without the code, and the delivered code still verifies', async () => {
    await withFixture(async (fixture) => {
      const { auth, handle, mail } = fixture;
      const userId = await createPasswordUser(fixture, OWNER);
      await auth.api.enableTwoFactor({
        body: { password: PASSWORD, method: 'otp' },
        headers: new Headers({ cookie: await signedInCookie(auth, OWNER) }),
      });

      const challenge = await auth.api.signInEmail({
        body: { email: OWNER, password: PASSWORD },
        returnHeaders: true,
      });
      expect(challenge.response).toMatchObject({ twoFactorRedirect: true });
      const pending = new Headers({
        cookie: cookiePair(challenge.headers, 'better-auth.two_factor'),
      });
      await auth.api.sendTwoFactorOTP({ body: {}, headers: pending });
      expect(mail.sent).toHaveLength(1);
      const code = /\b(\d{6})\b/.exec(mail.sent[0]?.text ?? '')?.[1] ?? '';

      const rows = await storedVerifications(handle);
      expect(
        rows.filter((row) => row.identifier.startsWith('2fa-otp-')),
      ).toHaveLength(1);
      expectNotAtRest(rows, code);

      const verified = await auth.api.verifyTwoFactorOTP({
        body: { code },
        headers: pending,
        returnHeaders: true,
      });
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: sessionCookieOf(verified.headers) }),
      });
      expect(session?.user.id).toBe(userId);
    });
  });
});
