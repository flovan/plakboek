import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import {
  createPermissionResolver,
  defaultRoles,
  defineRoles,
} from '@plakboek/permissions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditWriteError,
  PermissionDeniedError,
  createAuditRecorder,
  type AuditActor,
  type AuditRecorder,
} from '../../src/audit.js';
import { createAuth, type Auth } from '../../src/config.js';
import {
  completeSetPassword,
  requestPasswordLink,
  type PasswordLinkPurpose,
} from '../../src/credentials.js';
import { RESET_PASSWORD_SUBJECT } from '../../src/email/templates/reset-password.js';
import { SET_PASSWORD_SUBJECT } from '../../src/email/templates/set-password.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from '../../src/email/types.js';
import {
  FIRST_USER_LOCK_KEY,
  SUPERADMIN_ROLE_KEY,
  createUserWithRole,
} from '../../src/first-user.js';
import {
  InviteDeliveryError,
  inviteUser,
  resendSetPasswordLink,
} from '../../src/invite.js';
import { InvalidOrExpiredTokenError } from '../../src/tokens.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'invite-test-secret-with-at-least-32-characters';
const INVITEE = 'invitee@example.com';
const INVITEE_NAME = 'Invited Editor';
const PASSWORD = 'a freshly chosen passphrase';
const LINK_PATTERN = /https?:\/\/\S+[?&]token=[\w-]+/;
const HOUR_SECONDS = 60 * 60;

const roles = defineRoles(defaultRoles);

type ControlledSender = MailSender & {
  readonly sent: MailMessage[];
  failing: boolean;
};

type Fixture = {
  readonly testDatabase: TestDatabase;
  readonly handle: Db;
  readonly auth: Auth;
  readonly mail: ControlledSender;
  readonly recorder: AuditRecorder;
};

let current: Fixture | undefined;

function fixture(): Fixture {
  if (current === undefined) {
    throw new Error('the per-test database fixture is not set up');
  }
  return current;
}

/** Records every accepted message; while `failing` is set, rejects the way
 * a transport that refused the message does. */
function controlledSender(): ControlledSender {
  const sender: ControlledSender = {
    sent: [],
    failing: false,
    send(message) {
      if (sender.failing) {
        return Promise.reject(new MailSendError(message.to));
      }
      sender.sent.push(message);
      return Promise.resolve();
    },
  };
  return sender;
}

beforeEach(async () => {
  const testDatabase = await createTestDatabase();
  try {
    const { connectionString } = testDatabase;
    await runMigrations({ connectionString });
    const handle = createDb({ connectionString });
    const mail = controlledSender();
    const auth = createAuth({
      db: handle.db,
      baseURL: BASE_URL,
      secret: SECRET,
      mail,
      roles,
    });
    const recorder = createAuditRecorder({
      db: handle.db,
      resolver: createPermissionResolver(roles),
    });
    current = { testDatabase, handle, auth, mail, recorder };
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

async function createActor(
  email: string,
  roleKey: string,
): Promise<AuditActor> {
  const created = await createUserWithRole(fixture().handle.db, {
    id: randomUUID(),
    email,
    name: roleKey,
    roleKey,
  });
  return { userId: created.userId, roleKey: created.roleKey };
}

/** An installation whose first user is the superadmin, plus an editor. */
async function seedInstallation(): Promise<{
  readonly superadmin: AuditActor;
  readonly editor: AuditActor;
}> {
  const superadmin = await createActor('owner@example.com', 'editor');
  const editor = await createActor('editor@example.com', 'editor');
  expect(superadmin.roleKey).toBe(SUPERADMIN_ROLE_KEY);
  return { superadmin, editor };
}

function invite(
  actor: AuditActor,
  email: string = INVITEE,
  options: { readonly roleKey?: string; readonly id?: string } = {},
) {
  const { recorder, mail } = fixture();
  return inviteUser(
    { recorder, mail, baseURL: BASE_URL },
    {
      email,
      name: INVITEE_NAME,
      roleKey: options.roleKey ?? 'editor',
      actor,
      ...(options.id === undefined ? {} : { id: options.id }),
    },
  );
}

function resend(actor: AuditActor, email: string = INVITEE) {
  const { recorder, mail } = fixture();
  return resendSetPasswordLink(
    { recorder, mail, baseURL: BASE_URL },
    { email, actor },
  );
}

function tokenOf(message: MailMessage | undefined): string {
  const link =
    message === undefined ? undefined : LINK_PATTERN.exec(message.text)?.[0];
  const token =
    link === undefined ? null : new URL(link).searchParams.get('token');
  if (token === null) {
    throw new Error('the message carries no link token');
  }
  return token;
}

function lastToken(): string {
  const { sent } = fixture().mail;
  return tokenOf(sent.at(-1));
}

function complete(purpose: PasswordLinkPurpose, token: string) {
  const { handle, auth } = fixture();
  return completeSetPassword(
    { db: handle.db, auth },
    { purpose, token, newPassword: PASSWORD },
  );
}

async function signsIn(email: string, password: string): Promise<string> {
  const signedIn = await fixture().auth.api.signInEmail({
    body: { email, password },
  });
  return signedIn.user.id;
}

async function countOf(
  query: Promise<readonly { count: number }[]>,
): Promise<number> {
  const [row] = await query;
  return row?.count ?? 0;
}

function usersWithEmail(email: string) {
  return countOf(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "user" WHERE email = ${email}
  `);
}

function userCount() {
  return countOf(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "user"
  `);
}

function outstandingLinks(userId: string, purpose: PasswordLinkPurpose) {
  return countOf(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM verification
    WHERE value = ${userId} AND identifier LIKE ${`${purpose}:%`}
  `);
}

function verificationCount() {
  return countOf(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM verification
  `);
}

function credentialAccounts(userId: string) {
  return countOf(fixture().handle.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM account
    WHERE user_id = ${userId} AND provider_id = 'credential'
  `);
}

async function storedUser(email: string) {
  const [row] = await fixture().handle.sql<{ id: string; roleKey: string }[]>`
    SELECT id, role_key AS "roleKey" FROM "user" WHERE email = ${email}
  `;
  if (row === undefined) {
    throw new Error('expected a user row for the address');
  }
  return row;
}

type AuditRow = {
  readonly action: string;
  readonly outcome: string;
  readonly actorUserId: string | null;
  readonly actorRoleKey: string;
  readonly permission: string;
  readonly entityType: string;
  readonly beforeIsNull: boolean;
  readonly after: unknown;
  readonly afterText: string | null;
};

function auditRows(): Promise<AuditRow[]> {
  return fixture().handle.sql<AuditRow[]>`
    SELECT action, outcome, actor_user_id AS "actorUserId",
           actor_role_key AS "actorRoleKey", permission,
           entity_type AS "entityType", before IS NULL AS "beforeIsNull",
           after, after::text AS "afterText"
    FROM audit_log ORDER BY id
  `;
}

/** Moves a link's issue instant `ageSeconds` into the past, keeping its
 * 48-hour window. */
async function backdateLink(
  userId: string,
  purpose: PasswordLinkPurpose,
  ageSeconds: number,
): Promise<void> {
  await fixture().handle.sql`
    UPDATE verification
    SET created_at = now() - make_interval(secs => ${ageSeconds}),
        updated_at = now() - make_interval(secs => ${ageSeconds}),
        expires_at = now() - make_interval(secs => ${ageSeconds})
                     + interval '48 hours'
    WHERE value = ${userId} AND identifier LIKE ${`${purpose}:%`}
  `;
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('inviting a user (AUTH-02, AUTH-03)', () => {
  it('creates the user with the requested role and mails one link that sets a password (AUTH-02)', async () => {
    const { superadmin } = await seedInstallation();

    const result = await invite(superadmin);

    const stored = await storedUser(INVITEE);
    expect(result).toEqual({ userId: stored.id, wasFirstUser: false });
    expect(stored.roleKey).toBe('editor');
    expect(await usersWithEmail(INVITEE)).toBe(1);
    expect(fixture().mail.sent).toHaveLength(1);
    expect(fixture().mail.sent[0]).toMatchObject({
      to: INVITEE,
      subject: SET_PASSWORD_SUBJECT,
    });
    expect(await credentialAccounts(stored.id)).toBe(0);

    await complete('set-password', lastToken());

    expect(await signsIn(INVITEE, PASSWORD)).toBe(stored.id);
    expect(await credentialAccounts(stored.id)).toBe(1);
  });

  it('stores an invited address trimmed and lower-cased, so the link request and completion find the user', async () => {
    const { superadmin } = await seedInstallation();
    const { handle, mail } = fixture();

    const { userId } = await invite(superadmin, ' Ada@Example.TEST ');

    const stored = await storedUser('ada@example.test');
    expect(stored.id).toBe(userId);
    expect(mail.sent.map((message) => message.to)).toEqual([
      'ada@example.test',
    ]);

    await requestPasswordLink(
      { db: handle.db, mail, baseURL: BASE_URL },
      { email: 'ada@example.test', purpose: 'set-password' },
    );
    expect(mail.sent).toHaveLength(2);
    await expect(complete('set-password', lastToken())).resolves.toEqual({
      userId,
    });
    expect(await signsIn('ada@example.test', PASSWORD)).toBe(userId);
  });

  it('stops completing once the link is 48 hours old, and completes at 47 hours (AUTH-03)', async () => {
    const { superadmin } = await seedInstallation();
    const { userId } = await invite(superadmin);
    const token = lastToken();

    await backdateLink(userId, 'set-password', 48 * HOUR_SECONDS + 1);
    await expect(complete('set-password', token)).rejects.toBeInstanceOf(
      InvalidOrExpiredTokenError,
    );
    expect(await credentialAccounts(userId)).toBe(0);

    await backdateLink(userId, 'set-password', 47 * HOUR_SECONDS);
    await expect(complete('set-password', token)).resolves.toEqual({ userId });
  });

  it('forces superadmin on the first user of an empty installation, whatever role was asked for (AUTH-01, D-14)', async () => {
    const id = randomUUID();
    expect(await userCount()).toBe(0);

    const result = await invite(
      { userId: id, roleKey: SUPERADMIN_ROLE_KEY },
      INVITEE,
      { roleKey: 'editor', id },
    );

    expect(result).toEqual({ userId: id, wasFirstUser: true });
    expect((await storedUser(INVITEE)).roleKey).toBe(SUPERADMIN_ROLE_KEY);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user.invite',
      outcome: 'allowed',
      actorUserId: id,
      after: { userId: id, roleKey: SUPERADMIN_ROLE_KEY, created: true },
    });
    expect(fixture().mail.sent).toHaveLength(1);
  });

  it('commits nothing and sends nothing when the audit row cannot be written', async () => {
    expect(await userCount()).toBe(0);

    // On an empty installation an actor that is not the invitee names no
    // user row, so its audit row is refused by the foreign key.
    const error = await caught(() =>
      invite({ userId: randomUUID(), roleKey: SUPERADMIN_ROLE_KEY }),
    );

    expect(error).toBeInstanceOf(AuditWriteError);
    expect(await userCount()).toBe(0);
    expect(await verificationCount()).toBe(0);
    expect(fixture().mail.sent).toEqual([]);
  });
});

describe('resending a link (AUTH-04, D-09)', () => {
  it('invalidates the previously issued link, leaving exactly one valid link', async () => {
    const { superadmin } = await seedInstallation();
    const { userId } = await invite(superadmin);
    const linkA = lastToken();

    await expect(resend(superadmin)).resolves.toEqual({ delivered: true });
    const linkB = lastToken();

    expect(linkB).not.toBe(linkA);
    expect(await outstandingLinks(userId, 'set-password')).toBe(1);
    await expect(complete('set-password', linkA)).rejects.toBeInstanceOf(
      InvalidOrExpiredTokenError,
    );
    await expect(complete('set-password', linkB)).resolves.toEqual({ userId });
  });

  it('leaves one valid link and two delivered messages when a resend follows the invite at once (AUTH-02)', async () => {
    const { superadmin } = await seedInstallation();

    const { userId } = await invite(superadmin);
    await resend(superadmin);

    const { sent } = fixture().mail;
    expect(sent).toHaveLength(2);
    expect(await outstandingLinks(userId, 'set-password')).toBe(1);
    const [first, second] = sent.map((message) => tokenOf(message));
    await expect(complete('set-password', first ?? '')).rejects.toBeInstanceOf(
      InvalidOrExpiredTokenError,
    );
    await expect(complete('set-password', second ?? '')).resolves.toEqual({
      userId,
    });
  });

  it('keeps the user and the link when delivery fails, and a resend recovers (AUTH-02)', async () => {
    const { superadmin } = await seedInstallation();
    const { mail } = fixture();
    mail.failing = true;

    const error = await caught(() => invite(superadmin));

    // The committed state comes first: it is what the send ordering protects.
    expect(await usersWithEmail(INVITEE)).toBe(1);
    const stored = await storedUser(INVITEE);
    expect(await outstandingLinks(stored.id, 'set-password')).toBe(1);
    expect(mail.sent).toEqual([]);
    expect(error).toBeInstanceOf(InviteDeliveryError);
    const delivery = error as InviteDeliveryError;
    expect(delivery.userId).toBe(stored.id);
    expect(delivery.recipientDomain).toBe('example.com');
    expect(delivery.message).not.toContain('invitee');
    expect(delivery.cause).toBeInstanceOf(MailSendError);

    mail.failing = false;
    await expect(resend(superadmin)).resolves.toEqual({ delivered: true });

    expect(mail.sent).toHaveLength(1);
    await expect(complete('set-password', lastToken())).resolves.toEqual({
      userId: stored.id,
    });
    expect(await signsIn(INVITEE, PASSWORD)).toBe(stored.id);
  });

  it('issues a reset-password link, recorded in the audit log, for a user who already set a password (AUTH-04)', async () => {
    const { superadmin } = await seedInstallation();
    const { userId } = await invite(superadmin);
    await complete('set-password', lastToken());
    const auditBefore = (await auditRows()).length;

    await expect(resend(superadmin)).resolves.toEqual({ delivered: true });

    expect(await outstandingLinks(userId, 'reset-password')).toBe(1);
    expect(await outstandingLinks(userId, 'set-password')).toBe(0);
    expect(fixture().mail.sent.at(-1)).toMatchObject({
      to: INVITEE,
      subject: RESET_PASSWORD_SUBJECT,
    });
    const recorded = (await auditRows()).slice(auditBefore);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: 'user.resend-set-password',
      outcome: 'allowed',
      actorUserId: superadmin.userId,
      after: { userId, recipientFound: true, linkPurpose: 'reset-password' },
    });

    await complete('reset-password', lastToken());
    expect(await signsIn(INVITEE, PASSWORD)).toBe(userId);
  });

  it('sends nothing and keeps no link for an address with no user, with the same outcome', async () => {
    const { superadmin } = await seedInstallation();

    await expect(resend(superadmin, 'nobody@example.com')).resolves.toEqual({
      delivered: true,
    });

    expect(fixture().mail.sent).toEqual([]);
    expect(await verificationCount()).toBe(0);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user.resend-set-password',
      outcome: 'allowed',
      after: { emailDomain: 'example.com', recipientFound: false },
    });
  });
});

describe('a second invite for a registered address (AUTH-02)', () => {
  it('creates no second user, returns the same outcome shape, and leaves one valid link', async () => {
    const { superadmin } = await seedInstallation();

    const first = await invite(superadmin);
    const second = await invite(superadmin, ` ${INVITEE.toUpperCase()} `, {
      roleKey: 'admin',
    });

    expect(Object.keys(second).toSorted()).toEqual(
      Object.keys(first).toSorted(),
    );
    expect(second).toEqual(first);
    expect(await usersWithEmail(INVITEE)).toBe(1);
    expect((await storedUser(INVITEE)).roleKey).toBe('editor');
    expect(await outstandingLinks(first.userId, 'set-password')).toBe(1);
    expect(fixture().mail.sent).toHaveLength(2);
    await expect(complete('set-password', lastToken())).resolves.toEqual({
      userId: first.userId,
    });
  });

  it('creates one user when two invites for a new address race past the lookup', async () => {
    const { superadmin } = await seedInstallation();
    const { handle } = fixture();

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Holding the first-user lock parks both invites inside user creation,
    // after each has looked the address up and found nothing.
    const holder = handle.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${FIRST_USER_LOCK_KEY}::bigint)`;
      locked();
      await released;
    });
    let invites: Promise<unknown[]> | undefined;
    try {
      await lockTaken;
      invites = Promise.all([invite(superadmin), invite(superadmin)]);
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        waiting = await countOf(handle.sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
        `);
      }
      expect(waiting).toBe(2);
    } finally {
      release();
      await holder;
    }

    const results = (await invites) as { userId: string }[];
    const stored = await storedUser(INVITEE);
    expect(results.map((result) => result.userId)).toEqual([
      stored.id,
      stored.id,
    ]);
    expect(await usersWithEmail(INVITEE)).toBe(1);
    expect(await outstandingLinks(stored.id, 'set-password')).toBe(1);
    expect(fixture().mail.sent).toHaveLength(2);
  });
});

describe('audit coverage of invites and resends (USER-08)', () => {
  it('writes one allowed row per invite and resend, naming the acting superadmin and no address or token', async () => {
    const { superadmin } = await seedInstallation();

    const { userId } = await invite(superadmin);
    await resend(superadmin);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'user.invite',
      outcome: 'allowed',
      actorUserId: superadmin.userId,
      actorRoleKey: SUPERADMIN_ROLE_KEY,
      permission: 'users:create',
      entityType: 'user',
      beforeIsNull: true,
      after: {
        userId,
        emailDomain: 'example.com',
        roleKey: 'editor',
        created: true,
        linkPurpose: 'set-password',
      },
    });
    expect(rows[1]).toMatchObject({
      action: 'user.resend-set-password',
      outcome: 'allowed',
      actorUserId: superadmin.userId,
      permission: 'users:reset-password',
      entityType: 'user',
      beforeIsNull: true,
      after: {
        userId,
        emailDomain: 'example.com',
        recipientFound: true,
        linkPurpose: 'set-password',
      },
    });
    const tokens = fixture().mail.sent.map((message) => tokenOf(message));
    for (const row of rows) {
      expect(row.afterText).not.toContain('invitee@');
      expect(row.afterText).not.toContain(INVITEE_NAME);
      for (const token of tokens) {
        expect(row.afterText).not.toContain(token);
      }
    }
  });

  it('writes one denied row for an editor who tries to invite or resend, and creates nothing', async () => {
    const { superadmin, editor } = await seedInstallation();
    const { userId } = await invite(superadmin);
    const sentBefore = fixture().mail.sent.length;

    await expect(
      invite(editor, 'someone.else@example.com'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(resend(editor)).rejects.toBeInstanceOf(PermissionDeniedError);

    const denied = (await auditRows()).filter(
      (row) => row.outcome === 'denied',
    );
    expect(denied).toEqual([
      expect.objectContaining({
        action: 'user.invite',
        actorUserId: editor.userId,
        permission: 'users:create',
        after: null,
      }),
      expect.objectContaining({
        action: 'user.resend-set-password',
        actorUserId: editor.userId,
        permission: 'users:reset-password',
        after: null,
      }),
    ]);
    expect(await usersWithEmail('someone.else@example.com')).toBe(0);
    expect(await outstandingLinks(userId, 'set-password')).toBe(1);
    expect(fixture().mail.sent).toHaveLength(sentBefore);
  });
});
