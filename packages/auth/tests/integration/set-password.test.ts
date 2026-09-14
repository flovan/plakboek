import { createHash, randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/config.js';
import {
  CREDENTIAL_SET_ACTION,
  CredentialWriteError,
  completeSetPassword,
  requestPasswordLink,
  type PasswordLinkPurpose,
} from '../../src/credentials.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { PasswordPolicyError } from '../../src/password-policy.js';
import { InvalidOrExpiredTokenError } from '../../src/tokens.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'set-password-test-secret-with-at-least-32-characters';
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a much newer passphrase';
const SHORT_PASSWORD = 'eleven char';
const SESSION_COOKIE = 'better-auth.session_token';
const LINK_PATTERN = /https?:\/\/\S+[?&]token=[\w-]+/;

const roles = defineRoles(defaultRoles);

type RecordingSender = MailSender & { readonly sent: MailMessage[] };

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly auth: Auth;
  readonly mail: RecordingSender;
  /** A superadmin created first, so the subject below is not the first
   * user and holds the unprivileged `editor` role. */
  readonly ownerId: string;
};

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

function recordingSender(): RecordingSender {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    const { connectionString } = testDatabase;
    await runMigrations({ connectionString });
    const handle = createDb({ connectionString });
    const mail = recordingSender();
    const auth = createAuth({
      db: handle.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail,
      roles,
    });
    const owner = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: 'owner@example.com',
      name: 'Owner',
      roleKey: 'editor',
    });
    current = { testDatabase, handle, auth, mail, ownerId: owner.userId };
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

/** An editor, optionally with an email-and-password credential set through
 * better-auth's own hasher and adapter. */
async function createEditor(
  email: string,
  options: { readonly withPassword: boolean },
): Promise<string> {
  const { handle, auth } = fixture();
  const created = await createUserWithRole(handle.db, {
    id: randomUUID(),
    email,
    name: 'Editor',
    roleKey: 'editor',
  });
  if (options.withPassword) {
    const context = await auth.$context;
    await context.internalAdapter.linkAccount({
      userId: created.userId,
      providerId: 'credential',
      accountId: created.userId,
      password: await context.password.hash(OLD_PASSWORD),
    });
  }
  return created.userId;
}

/** Requests a link and returns the token from the message that arrived. */
async function requestLink(
  email: string,
  purpose: PasswordLinkPurpose,
): Promise<string> {
  const { handle, mail } = fixture();
  const before = mail.sent.length;
  await requestPasswordLink(
    { db: handle.db, mail, baseURL: BASE_URL },
    { email, purpose },
  );
  const message = mail.sent[before];
  if (message === undefined || mail.sent.length !== before + 1) {
    throw new Error(`expected exactly one message for the ${purpose} request`);
  }
  if (message.to !== email) {
    throw new Error('the link message went to the wrong recipient');
  }
  const link = LINK_PATTERN.exec(message.text)?.[0];
  const token =
    link === undefined ? null : new URL(link).searchParams.get('token');
  if (token === null) {
    throw new Error('the link message carries no token');
  }
  return token;
}

function complete(
  purpose: PasswordLinkPurpose,
  token: string,
  newPassword: string,
) {
  const { handle, auth } = fixture();
  return completeSetPassword(
    { db: handle.db, auth },
    { purpose, token, newPassword },
  );
}

async function signIn(email: string, password: string): Promise<Headers> {
  const result = await fixture().auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  for (const cookie of result.headers.getSetCookie()) {
    const [pair = ''] = cookie.split(';');
    if (pair.startsWith(`${SESSION_COOKIE}=`)) {
      return new Headers({ cookie: pair });
    }
  }
  throw new Error('sign-in set no session cookie');
}

async function countRows(
  query: Promise<readonly { count: number }[]>,
): Promise<number> {
  const [row] = await query;
  return row?.count ?? 0;
}

function outstandingLinks(userId: string, purpose: PasswordLinkPurpose) {
  return countRows(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM verification
    WHERE value = ${userId} AND identifier LIKE ${`${purpose}:%`}
  `);
}

function credentialAccounts(userId: string) {
  return countRows(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM account
    WHERE user_id = ${userId} AND provider_id = 'credential'
  `);
}

function sessionsOf(userId: string) {
  return countRows(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM session WHERE user_id = ${userId}
  `);
}

function auditRowCount() {
  return countRows(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_log
  `);
}

/** Every error along the cause chain, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let currentError = error;
  while (currentError instanceof Error && chain.length < 5) {
    chain.push(currentError);
    currentError = currentError.cause;
  }
  return chain;
}

describe('completing a password link (AUTH-05)', () => {
  it('resets a password through the emailed link, and the new password signs in', async () => {
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });

    const token = await requestLink(email, 'reset-password');
    const result = await complete('reset-password', token, NEW_PASSWORD);

    expect(result).toEqual({ userId });
    const signedIn = await fixture().auth.api.signInEmail({
      body: { email, password: NEW_PASSWORD },
    });
    expect(signedIn.user.id).toBe(userId);
    await expect(signIn(email, OLD_PASSWORD)).rejects.toThrow(
      /invalid email or password/i,
    );
    expect(await credentialAccounts(userId)).toBe(1);
  });

  it('sets a first password for an invited user who has no credential yet', async () => {
    const email = 'invitee@example.com';
    const userId = await createEditor(email, { withPassword: false });

    const token = await requestLink(email, 'set-password');
    await complete('set-password', token, NEW_PASSWORD);

    const signedIn = await fixture().auth.api.signInEmail({
      body: { email, password: NEW_PASSWORD },
    });
    expect(signedIn.user.id).toBe(userId);
    expect(await credentialAccounts(userId)).toBe(1);
  });
});

describe('the link is spent only when the password is set (AUTH-06, AUTH-11, AUTH-03)', () => {
  it('rejects a password below the minimum before spending the link', async () => {
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });
    const token = await requestLink(email, 'reset-password');

    await expect(
      complete('reset-password', token, SHORT_PASSWORD),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
    expect(await outstandingLinks(userId, 'reset-password')).toBe(1);
    expect(await auditRowCount()).toBe(0);

    await expect(
      complete('reset-password', token, NEW_PASSWORD),
    ).resolves.toEqual({ userId });
    expect(await outstandingLinks(userId, 'reset-password')).toBe(0);
  });

  it('checks the password before it looks at the link', async () => {
    await createEditor('editor@example.com', { withPassword: true });

    await expect(
      complete(
        'reset-password',
        'a-link-that-was-never-issued',
        SHORT_PASSWORD,
      ),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
  });

  it('refuses a short password without waiting on the link row another transaction holds', async () => {
    const { handle } = fixture();
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });
    const token = await requestLink(email, 'reset-password');

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = handle.sql.begin(async (sql) => {
      await sql`SELECT 1 FROM verification WHERE value = ${userId} FOR UPDATE`;
      locked();
      await released;
    });
    try {
      await lockTaken;
      const settled = await Promise.race([
        complete('reset-password', token, SHORT_PASSWORD).then(
          () => 'fulfilled',
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still waiting on the row lock'), 2000),
        ),
      ]);
      expect(settled).toBeInstanceOf(PasswordPolicyError);
    } finally {
      release();
      await holder;
    }
    expect(await outstandingLinks(userId, 'reset-password')).toBe(1);
  });

  it('keeps the link and writes no credential when the credential write fails', async () => {
    const { handle } = fixture();
    const email = 'invitee@example.com';
    const userId = await createEditor(email, { withPassword: false });
    const token = await requestLink(email, 'set-password');
    // A test-only trigger makes every credential write fail inside the
    // consuming transaction.
    await handle.sql.unsafe(`
      CREATE FUNCTION refuse_credential_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'credential write refused by the test';
      END
      $$;
      CREATE TRIGGER refuse_credential_write
        BEFORE INSERT OR UPDATE ON account
        FOR EACH ROW EXECUTE FUNCTION refuse_credential_write();
    `);

    const failure = await complete('set-password', token, NEW_PASSWORD).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CredentialWriteError);
    expect(failure).toMatchObject({ code: 'P0001' });
    expect(await outstandingLinks(userId, 'set-password')).toBe(1);
    expect(await credentialAccounts(userId)).toBe(0);
    expect(await auditRowCount()).toBe(0);

    await handle.sql.unsafe('DROP TRIGGER refuse_credential_write ON account');
    await expect(
      complete('set-password', token, NEW_PASSWORD),
    ).resolves.toEqual({ userId });
    expect(await credentialAccounts(userId)).toBe(1);
  });

  it('never quotes the new password or its hash in a credential write failure', async () => {
    const { handle } = fixture();
    const email = 'invitee@example.com';
    await createEditor(email, { withPassword: false });
    const token = await requestLink(email, 'set-password');
    await handle.sql.unsafe(`
      CREATE FUNCTION refuse_credential_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'credential write refused by the test';
      END
      $$;
      CREATE TRIGGER refuse_credential_write
        BEFORE INSERT OR UPDATE ON account
        FOR EACH ROW EXECUTE FUNCTION refuse_credential_write();
    `);

    const failure = await complete('set-password', token, NEW_PASSWORD).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CredentialWriteError);
    for (const link of causeChain(failure)) {
      const text = `${String(link)} ${JSON.stringify(link)}`;
      expect(text).not.toContain(NEW_PASSWORD);
      expect(text).not.toContain('$scrypt');
      expect(text).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{64}/);
    }
  });

  it('spends the link on success, so presenting it again is rejected', async () => {
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });
    const token = await requestLink(email, 'reset-password');

    await complete('reset-password', token, NEW_PASSWORD);

    expect(await outstandingLinks(userId, 'reset-password')).toBe(0);
    await expect(
      complete('reset-password', token, 'yet another passphrase'),
    ).rejects.toBeInstanceOf(InvalidOrExpiredTokenError);
    const signedIn = await fixture().auth.api.signInEmail({
      body: { email, password: NEW_PASSWORD },
    });
    expect(signedIn.user.id).toBe(userId);
  });

  it('refuses a link presented for a purpose it was not issued for', async () => {
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });
    const token = await requestLink(email, 'reset-password');

    await expect(
      complete('set-password', token, NEW_PASSWORD),
    ).rejects.toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(await outstandingLinks(userId, 'reset-password')).toBe(1);
  });

  it('ends every other outstanding set-password or reset-password link for the user', async () => {
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: false });
    const otherId = await createEditor('other@example.com', {
      withPassword: false,
    });
    const inviteToken = await requestLink(email, 'set-password');
    const resetToken = await requestLink(email, 'reset-password');
    await requestLink('other@example.com', 'set-password');

    await complete('reset-password', resetToken, NEW_PASSWORD);

    expect(await outstandingLinks(userId, 'set-password')).toBe(0);
    await expect(
      complete('set-password', inviteToken, 'yet another passphrase'),
    ).rejects.toBeInstanceOf(InvalidOrExpiredTokenError);
    expect(await outstandingLinks(otherId, 'set-password')).toBe(1);
  });
});

describe('completing a link ends the sessions it was meant to end', () => {
  it('revokes every existing session for the user, and leaves other users signed in', async () => {
    const { auth, handle } = fixture();
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });
    const otherEmail = 'other@example.com';
    const otherId = await createEditor(otherEmail, { withPassword: true });
    const firstDevice = await signIn(email, OLD_PASSWORD);
    const secondDevice = await signIn(email, OLD_PASSWORD);
    const otherDevice = await signIn(otherEmail, OLD_PASSWORD);
    expect(await sessionsOf(userId)).toBe(2);
    // An impersonation session this user started, held under the target.
    await handle.sql`
      INSERT INTO session (id, token, user_id, impersonated_by, expires_at,
                           created_at, updated_at)
      VALUES (${randomUUID()}, ${randomUUID()}, ${otherId}, ${userId},
              now() + interval '1 hour', now(), now())
    `;

    const token = await requestLink(email, 'reset-password');
    await complete('reset-password', token, NEW_PASSWORD);

    expect(await sessionsOf(userId)).toBe(0);
    await expect(
      auth.api.getSession({ headers: firstDevice }),
    ).resolves.toBeNull();
    await expect(
      auth.api.getSession({ headers: secondDevice }),
    ).resolves.toBeNull();
    const impersonating = await countRows(handle.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM session
      WHERE impersonated_by = ${userId}
    `);
    expect(impersonating).toBe(0);
    const other = await auth.api.getSession({ headers: otherDevice });
    expect(other?.user.id).toBe(otherId);
    expect(await sessionsOf(otherId)).toBe(1);
  });
});

describe('the credential change is audited (USER-08)', () => {
  it('writes one audit row naming the user whose credential changed', async () => {
    const email = 'editor@example.com';
    const userId = await createEditor(email, { withPassword: true });
    await signIn(email, OLD_PASSWORD);
    const token = await requestLink(email, 'reset-password');

    await complete('reset-password', token, NEW_PASSWORD);

    const rows = await fixture().handle.sql<
      {
        actorUserId: string | null;
        actorRoleKey: string;
        impersonatorUserId: string | null;
        permission: string;
        action: string;
        entityType: string;
        entityId: string | null;
        outcome: string;
        beforeIsNull: boolean;
        after: unknown;
      }[]
    >`
      SELECT actor_user_id AS "actorUserId", actor_role_key AS "actorRoleKey",
             impersonator_user_id AS "impersonatorUserId", permission, action,
             entity_type AS "entityType", entity_id AS "entityId", outcome,
             before IS NULL AS "beforeIsNull", after
      FROM audit_log
    `;
    expect([...rows]).toEqual([
      {
        actorUserId: userId,
        actorRoleKey: 'editor',
        impersonatorUserId: null,
        permission: 'users:reset-password',
        action: CREDENTIAL_SET_ACTION,
        entityType: 'user',
        entityId: userId,
        outcome: 'allowed',
        beforeIsNull: true,
        after: { purpose: 'reset-password', revokedSessionCount: 1 },
      },
    ]);

    const [stored] = await fixture().handle.sql<{ password: string }[]>`
      SELECT password FROM account
      WHERE user_id = ${userId} AND provider_id = 'credential'
    `;
    const serialised = JSON.stringify([...rows]);
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain(stored?.password ?? NEW_PASSWORD);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(
      createHash('sha256').update(token).digest('base64url'),
    );
  });
});
