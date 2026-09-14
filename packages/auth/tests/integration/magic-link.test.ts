import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuth,
  type Auth,
  type CreateAuthOptions,
} from '../../src/config.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { createTestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'magic-link-test-secret-with-at-least-32-characters';
const SESSION_COOKIE = 'better-auth.session_token';
const MAGIC_LINK_WINDOW_MS = 900 * 1000;
const TOLERANCE_MS = 5000;
const KNOWN = 'ada@example.com';
const UNKNOWN = 'nobody@example.com';

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

/** Runs `body` against a freshly migrated database that is dropped after,
 * with one existing user at `KNOWN`. */
async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
  overrides: Partial<CreateAuthOptions> = {},
) {
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
      ...overrides,
    });
    await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: KNOWN,
      name: 'Ada',
      roleKey: 'editor',
    });
    await body({ auth, handle, mail });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await testDatabase.drop();
  }
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

function requestMagicLink(auth: Auth, email: string) {
  return auth.api.signInMagicLink({
    body: { email },
    headers: new Headers(),
  });
}

function linkFrom(message: MailMessage | undefined): string {
  const link = /https?:\/\/\S*magic-link\/verify\S*/.exec(
    message?.text ?? '',
  )?.[0];
  expect(link).toBeDefined();
  return link ?? '';
}

function tokenOf(link: string): string {
  return new URL(link).searchParams.get('token') ?? '';
}

/** The identifier a token is stored under: its SHA-256 digest, base64url
 * without padding, because the plugin stores tokens hashed. */
function storedIdentifier(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Follows a link exactly as a browser would, through the HTTP handler. */
async function follow(auth: Auth, link: string) {
  const response = await auth.handler(new Request(link));
  const sessionCookie = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  return { response, sessionCookie };
}

async function sessionCount(handle: Db): Promise<number> {
  const [row] = await handle.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM session
  `;
  return row?.n ?? -1;
}

async function userCount(handle: Db): Promise<number> {
  const [row] = await handle.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "user"
  `;
  return row?.n ?? -1;
}

/** Makes one issued link look `interval` older than it is. */
async function age(handle: Db, token: string, interval: string) {
  await handle.sql`
    UPDATE verification
    SET expires_at = expires_at - ${interval}::interval,
        created_at = created_at - ${interval}::interval
    WHERE identifier = ${storedIdentifier(token)}
  `;
}

describe('magic link sign-in (AUTH-09, D-10)', () => {
  it('delivers one link to an existing user that signs them in', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      const outcome = await requestMagicLink(auth, KNOWN);
      await flushDetached();

      expect(outcome).toEqual({ status: true });
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(KNOWN);

      const { response, sessionCookie } = await follow(
        auth,
        linkFrom(mail.sent[0]),
      );
      expect(response.status).toBe(302);
      expect(sessionCookie).toBeDefined();

      const session = await auth.api.getSession({
        headers: new Headers({ cookie: sessionCookie ?? '' }),
      });
      expect(session?.user.email).toBe(KNOWN);
      expect(await sessionCount(handle)).toBe(1);
    });
  });

  it('stores the link with an expiry fifteen minutes after issue', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      const before = Date.now();
      await requestMagicLink(auth, KNOWN);
      const after = Date.now();
      await flushDetached();

      const token = tokenOf(linkFrom(mail.sent[0]));
      const [row] = await handle.sql<{ expiresAtMs: number }[]>`
        SELECT (extract(epoch FROM expires_at) * 1000)::float8 AS "expiresAtMs"
        FROM verification WHERE identifier = ${storedIdentifier(token)}
      `;
      expect(row?.expiresAtMs).toBeGreaterThanOrEqual(
        before + MAGIC_LINK_WINDOW_MS - TOLERANCE_MS,
      );
      expect(row?.expiresAtMs).toBeLessThanOrEqual(
        after + MAGIC_LINK_WINDOW_MS + TOLERANCE_MS,
      );
    });
  });

  it('accepts a link just inside fifteen minutes and rejects one just past it', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      await requestMagicLink(auth, KNOWN);
      await requestMagicLink(auth, KNOWN);
      await flushDetached();
      expect(mail.sent).toHaveLength(2);
      const [inside, past] = mail.sent.map((message) => linkFrom(message));

      await age(handle, tokenOf(inside ?? ''), '14 minutes 50 seconds');
      await age(handle, tokenOf(past ?? ''), '15 minutes 1 second');

      const expired = await follow(auth, past ?? '');
      expect(expired.sessionCookie).toBeUndefined();
      expect(expired.response.headers.get('location')).toContain(
        'error=INVALID_TOKEN',
      );
      expect(await sessionCount(handle)).toBe(0);

      const accepted = await follow(auth, inside ?? '');
      expect(accepted.sessionCookie).toBeDefined();
      expect(await sessionCount(handle)).toBe(1);
    });
  });

  it('answers an unknown address in the same shape, sends nothing and creates nobody', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      const known = await requestMagicLink(auth, KNOWN);
      await flushDetached();
      const sentForKnown = mail.sent.length;

      const unknown = await requestMagicLink(auth, UNKNOWN);
      await flushDetached();

      expect(unknown).toEqual(known);
      expect(mail.sent).toHaveLength(sentForKnown);
      expect(mail.sent.map((message) => message.to)).not.toContain(UNKNOWN);

      // Even a working link for the unknown address cannot register it.
      // The stored identifier is a digest, not a usable token, so the issued
      // row is re-keyed to a token this test holds.
      const [issued] = await handle.sql<{ identifier: string }[]>`
        SELECT identifier FROM verification WHERE value LIKE ${`%${UNKNOWN}%`}
      `;
      expect(issued).toBeDefined();
      const token = randomBytes(24).toString('base64url');
      await handle.sql`
        UPDATE verification SET identifier = ${storedIdentifier(token)}
        WHERE identifier = ${issued?.identifier ?? ''}
      `;
      const link = new URL('/api/auth/magic-link/verify', BASE_URL);
      link.searchParams.set('token', token);
      link.searchParams.set('callbackURL', '/');
      const followed = await follow(auth, link.toString());

      expect(followed.sessionCookie).toBeUndefined();
      expect(await sessionCount(handle)).toBe(0);
      expect(await userCount(handle)).toBe(1);
    });
  });
});

describe('magic link delivery is detached from the request (D-15)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it('still answers when the send never settles', async () => {
    const attempted: MailMessage[] = [];
    const neverSettles: MailSender = {
      send: (message) => {
        attempted.push(message);
        return new Promise<void>(() => undefined);
      },
    };

    await withFixture(
      async ({ auth }) => {
        const outcome = await Promise.race([
          requestMagicLink(auth, KNOWN),
          new Promise<'timed out'>((resolve) => {
            setTimeout(resolve, 5000, 'timed out');
          }),
        ]);
        expect(outcome).toEqual({ status: true });
        expect(attempted).toHaveLength(1);
      },
      { mail: neverSettles },
    );
  });

  it('still answers when the send rejects, and reports the failure once', async () => {
    process.on('unhandledRejection', onUnhandled);
    const onMailDeliveryError = vi.fn<(error: unknown) => void>();
    const rejecting: MailSender = {
      send: (message) => Promise.reject(new MailSendError(message.to)),
    };

    await withFixture(
      async ({ auth }) => {
        const outcome = await requestMagicLink(auth, KNOWN);
        await flushDetached();

        expect(outcome).toEqual({ status: true });
        expect(onMailDeliveryError).toHaveBeenCalledTimes(1);
        expect(onMailDeliveryError.mock.calls[0]?.[0]).toBeInstanceOf(
          MailSendError,
        );
        expect(unhandled).toEqual([]);
      },
      { mail: rejecting, onMailDeliveryError },
    );
  });
});
