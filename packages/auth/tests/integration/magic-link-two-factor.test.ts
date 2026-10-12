import { createHash, randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/config.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { createTestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'magic-two-factor-test-secret-with-at-least-32-characters';
const SESSION_COOKIE = 'better-auth.session_token';
const PLAIN = 'plain@example.com';
const GUARDED = 'guarded@example.com';
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

/** A fresh database with two editors: `PLAIN` without two-factor and
 * `GUARDED`, who has it enabled. */
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
    for (const email of [PLAIN, GUARDED]) {
      await createUserWithRole(handle.db, {
        id: randomUUID(),
        email,
        name: 'Editor',
        roleKey: 'editor',
      });
    }
    await enableTwoFactor(handle, GUARDED);
    await body({ auth, handle, mail });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await testDatabase.drop();
  }
}

async function enableTwoFactor(handle: Db, email: string) {
  await handle.sql`UPDATE "user" SET two_factor_enabled = true WHERE email = ${email}`;
}

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

describe('a magic link cannot skip the second factor (T-07-10, D-26)', () => {
  it('sends nothing to a two-factor user and answers like it does for an unknown address', async () => {
    await withFixture(async ({ auth, mail }) => {
      const guarded = await requestMagicLink(auth, GUARDED);
      const unknown = await requestMagicLink(auth, UNKNOWN);
      await flushDetached();

      expect(guarded).toEqual({ status: true });
      expect(unknown).toEqual(guarded);
      expect(mail.sent).toHaveLength(0);
    });
  });

  it('still signs a user without two-factor in, unchanged', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      const outcome = await requestMagicLink(auth, PLAIN);
      await flushDetached();
      expect(outcome).toEqual({ status: true });
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(PLAIN);

      const { response, sessionCookie } = await follow(
        auth,
        linkFrom(mail.sent[0]),
      );
      expect(response.status).toBe(302);
      expect(sessionCookie).toBeDefined();
      expect(await sessionCount(handle)).toBe(1);
    });
  });

  it('produces no session when a link issued before enrolment is followed after it', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      await requestMagicLink(auth, PLAIN);
      await flushDetached();
      const link = linkFrom(mail.sent[0]);

      await enableTwoFactor(handle, PLAIN);
      const { response, sessionCookie } = await follow(auth, link);

      expect(sessionCookie).toBeUndefined();
      expect(await sessionCount(handle)).toBe(0);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('error=');
    });
  });

  it('keeps the link single-use even when the session was refused', async () => {
    await withFixture(async ({ auth, handle, mail }) => {
      await requestMagicLink(auth, PLAIN);
      await flushDetached();
      const link = linkFrom(mail.sent[0]);
      await enableTwoFactor(handle, PLAIN);

      await follow(auth, link);
      await handle.sql`UPDATE "user" SET two_factor_enabled = false WHERE email = ${PLAIN}`;
      const second = await follow(auth, link);

      expect(second.sessionCookie).toBeUndefined();
      expect(await sessionCount(handle)).toBe(0);
      const identifier = createHash('sha256')
        .update(new URL(link).searchParams.get('token') ?? '')
        .digest('base64url');
      const rows = await handle.sql`
        SELECT 1 FROM verification WHERE identifier = ${identifier}
      `;
      expect(rows).toHaveLength(0);
    });
  });
});
