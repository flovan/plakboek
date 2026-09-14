import { ALL_PERMISSIONS, type Permission } from '@plakboek/permissions';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import {
  PermissionDeniedError,
  type AuditActor,
  type AuditEntryInput,
  type AuditRecorder,
  type AuditTransaction,
} from '../../src/audit.js';
import type { RenderAuthEmail } from '../../src/config.js';
import { renderAuthEmail, type AuthEmailKind } from '../../src/email/render.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from '../../src/email/types.js';
import {
  InvalidInviteError,
  InviteDeliveryError,
  inviteUser,
  resendSetPasswordLink,
  type InviteDeps,
} from '../../src/invite.js';

const BASE_URL = 'https://cms.example.test';
const LOCAL_PART = 'augusta.invitee';
const INVITEE_EMAIL = `${LOCAL_PART}@example.test`;
const INVITEE_NAME = 'Augusta Ada King';
const KNOWN = {
  id: 'user-known',
  email: 'known.member@example.test',
  name: 'Known Member',
  role_key: 'editor',
};

type StoredUser = Record<'id' | 'email' | 'name' | 'role_key', string>;

type Statement = { readonly sql: string; readonly params: unknown[] };

type FakeDatabaseOptions = {
  readonly users?: readonly StoredUser[];
  readonly credentialUserIds?: readonly string[];
  /** Rejects the user insert with an error that echoes every bound value,
   * the way a driver error quoting its parameters would. */
  readonly failUserInsert?: boolean;
};

type FakeDatabase = {
  readonly tx: AuditTransaction;
  readonly statements: Statement[];
  readonly users: StoredUser[];
};

function placeholderValue(token: string | undefined, params: unknown[]) {
  return token?.startsWith('$') === true
    ? params[Number(token.slice(1)) - 1]
    : undefined;
}

function insertedRow(
  query: string,
  params: unknown[],
): Record<string, unknown> {
  const match = /^insert into "\w+" \(([^)]*)\) values \(([^)]*)\)/.exec(query);
  const columns = (match?.[1] ?? '').split(', ');
  const values = (match?.[2] ?? '').split(', ');
  return Object.fromEntries(
    columns.map((column, index) => [
      column.replaceAll('"', ''),
      placeholderValue(values[index], params),
    ]),
  );
}

function selectedColumns(query: string): (keyof StoredUser)[] {
  const list = /^select (.*?) from "user"/.exec(query)?.[1] ?? '';
  return list
    .split(', ')
    .map((column) => column.replace('"user".', '').replaceAll('"', ''))
    .filter((column): column is keyof StoredUser =>
      ['id', 'email', 'name', 'role_key'].includes(column),
    );
}

/**
 * An in-memory stand-in for the database seam: a real Drizzle query builder
 * over a callback driver, holding a small user table and a set of users with
 * a credential. It records every statement, and a transaction runs its
 * callback on the database itself.
 */
function fakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const users: StoredUser[] = [...(options.users ?? [])];
  const credentials = new Set(options.credentialUserIds ?? []);
  const statements: Statement[] = [];
  const db = drizzle((query, params) => {
    statements.push({ sql: query, params });
    if (query.startsWith('insert into "user"')) {
      if (options.failUserInsert === true) {
        return Promise.reject(
          new Error(`simulated insert failure; params: ${params.join(',')}`),
        );
      }
      const row = insertedRow(query, params);
      users.push({
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        role_key: String(row.role_key),
      });
      return Promise.resolve({ rows: [] });
    }
    if (query.includes('EXISTS (SELECT 1 FROM "user")')) {
      return Promise.resolve({ rows: [[users.length > 0]] });
    }
    if (query.startsWith('select') && query.includes('from "user"')) {
      const columns = selectedColumns(query);
      const found = users.filter((stored) => params.includes(stored.email));
      return Promise.resolve({
        rows: found.slice(0, 1).map((stored) => columns.map((c) => stored[c])),
      });
    }
    if (query.startsWith('select') && query.includes('from "account"')) {
      const has = params.some((param) => credentials.has(String(param)));
      return Promise.resolve({ rows: has ? [['account-1']] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  Object.defineProperty(db, 'transaction', {
    value: async (run: (tx: unknown) => Promise<unknown>) => await run(db),
  });
  return { tx: db as unknown as AuditTransaction, statements, users };
}

function insertsInto(statements: readonly Statement[], table: string): number {
  return statements.filter((statement) =>
    statement.sql.startsWith(`insert into "${table}"`),
  ).length;
}

type RecordedEntry = {
  readonly actor: AuditActor;
  readonly entry: AuditEntryInput;
  readonly after?: unknown;
};

type FakeRecorder = AuditRecorder & {
  readonly allowed: RecordedEntry[];
  readonly denied: RecordedEntry[];
};

function holding(...permissions: Permission[]): ReadonlySet<Permission> {
  return new Set(permissions);
}

function allExcept(missing: Permission): ReadonlySet<Permission> {
  return new Set(ALL_PERMISSIONS.filter((held) => held !== missing));
}

/**
 * Mirrors the real recorder's contract: a missing permission records a
 * denial and throws before the mutation runs; otherwise the mutation runs on
 * the transaction and its audit entry is recorded once it returns.
 */
function fakeRecorder(
  tx: AuditTransaction,
  roles: Readonly<Record<string, ReadonlySet<Permission>>>,
  events: string[] = [],
): FakeRecorder {
  const allowed: RecordedEntry[] = [];
  const denied: RecordedEntry[] = [];
  return {
    allowed,
    denied,
    async run(actor, entry, mutation) {
      if (roles[actor.roleKey]?.has(entry.permission) !== true) {
        denied.push({ actor, entry });
        events.push('denied');
        throw new PermissionDeniedError(entry.permission, actor.roleKey);
      }
      const { result, after } = await mutation(tx);
      allowed.push({ actor, entry, after: after ?? entry.after });
      events.push('committed');
      return result;
    },
    recordDenied(actor, entry) {
      denied.push({ actor, entry, after: entry.after });
      events.push('denied');
      return Promise.resolve();
    },
  };
}

type RecordingSender = MailSender & { readonly sent: MailMessage[] };

function recordingSender(events: string[] = []): RecordingSender {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      events.push('sent');
      return Promise.resolve();
    },
  };
}

function rejectingSender(error?: unknown): MailSender {
  return {
    send(message) {
      return Promise.reject(error ?? new MailSendError(message.to));
    },
  };
}

type RenderCall = {
  readonly kind: AuthEmailKind;
  readonly data: Record<string, string>;
};

function recordingRenderer(): {
  readonly renderEmail: RenderAuthEmail;
  readonly calls: RenderCall[];
} {
  const calls: RenderCall[] = [];
  return {
    calls,
    renderEmail(kind, data) {
      calls.push({ kind, data: { ...data } });
      return renderAuthEmail(kind, data);
    },
  };
}

const SUPERADMIN: AuditActor = { userId: 'user-owner', roleKey: 'superadmin' };

const ROLES: Readonly<Record<string, ReadonlySet<Permission>>> = {
  superadmin: holding(...ALL_PERMISSIONS),
  'no-create': allExcept('users:create'),
  'no-reset': allExcept('users:reset-password'),
};

function deps(
  tx: AuditTransaction,
  overrides: Partial<InviteDeps> & { readonly events?: string[] } = {},
): InviteDeps & { readonly mail: MailSender } {
  const { events, ...rest } = overrides;
  return {
    recorder: fakeRecorder(tx, ROLES, events),
    mail: recordingSender(events),
    baseURL: BASE_URL,
    ...rest,
  };
}

function inviteInput(email: string = INVITEE_EMAIL) {
  return {
    email,
    name: INVITEE_NAME,
    roleKey: 'editor',
    actor: SUPERADMIN,
  };
}

/** Every message along an error's cause chain. */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join('\n');
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function tokensOf(calls: readonly RenderCall[]): string[] {
  return calls.map(
    (call) =>
      new URL(call.data.url ?? BASE_URL).searchParams.get('token') ?? '',
  );
}

describe('inviteUser guards (AUTH-02)', () => {
  it('refuses a caller without users:create, records the denial and creates nothing', async () => {
    const { tx, statements } = fakeDatabase({ users: [KNOWN] });
    const recorder = fakeRecorder(tx, ROLES);
    const mail = recordingSender();

    await expect(
      inviteUser(
        { recorder, mail, baseURL: BASE_URL },
        {
          ...inviteInput(),
          actor: { userId: 'user-manager', roleKey: 'no-create' },
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(recorder.denied.map((denial) => denial.entry.permission)).toEqual([
      'users:create',
    ]);
    expect(recorder.denied[0]?.entry.action).toBe('user.invite');
    expect(recorder.allowed).toEqual([]);
    expect(insertsInto(statements, 'user')).toBe(0);
    expect(insertsInto(statements, 'verification')).toBe(0);
    expect(mail.sent).toEqual([]);
  });

  it.each([
    ['no at sign', 'augusta.example.test'],
    ['an empty local part', '@example.test'],
    ['an empty domain', 'augusta@'],
    ['two at signs', 'augusta@@example.test'],
    ['two addresses', 'augusta@example.test@example.org'],
    ['whitespace only', '   '],
    ['a control character', 'augusta\n@example.test'],
    ['a value that is not a string', 42],
  ])('rejects an address with %s before any work', async (_label, email) => {
    const { tx, statements } = fakeDatabase();
    const recorder = fakeRecorder(tx, ROLES);
    const mail = recordingSender();

    const error = await caught(() =>
      inviteUser(
        { recorder, mail, baseURL: BASE_URL },
        { ...inviteInput(), email: email as string },
      ),
    );

    expect(error).toBeInstanceOf(InvalidInviteError);
    expect((error as InvalidInviteError).field).toBe('email');
    expect(statements).toEqual([]);
    expect(recorder.allowed).toEqual([]);
    expect(recorder.denied).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('stores the address trimmed and lower-cased and mails the set-password link there', async () => {
    const { tx, users } = fakeDatabase({ users: [KNOWN] });
    const mail = recordingSender();
    const renderer = recordingRenderer();

    await inviteUser(
      { ...deps(tx), mail, renderEmail: renderer.renderEmail },
      inviteInput(' Augusta.Invitee@Example.TEST '),
    );

    expect(users.map((stored) => stored.email)).toEqual([
      KNOWN.email,
      INVITEE_EMAIL,
    ]);
    expect(mail.sent.map((message) => message.to)).toEqual([INVITEE_EMAIL]);
    expect(renderer.calls.map((call) => call.kind)).toEqual(['set-password']);
  });

  it('returns the created user id, with wasFirstUser true only on an empty installation', async () => {
    const empty = fakeDatabase();
    const first = await inviteUser(deps(empty.tx), inviteInput());

    const populated = fakeDatabase({ users: [KNOWN] });
    const later = await inviteUser(deps(populated.tx), inviteInput());

    expect(first).toEqual({ userId: empty.users[0]?.id, wasFirstUser: true });
    expect(empty.users[0]?.role_key).toBe('superadmin');
    expect(later).toEqual({
      userId: populated.users[1]?.id,
      wasFirstUser: false,
    });
    expect(populated.users[1]?.role_key).toBe('editor');
    expect(first.userId).not.toBe(later.userId);
  });

  it('treats an address that already has a user as a resend, with the same outcome shape', async () => {
    const { tx, statements, users } = fakeDatabase({ users: [KNOWN] });
    const mail = recordingSender();

    const outcome = await inviteUser(
      { ...deps(tx), mail },
      inviteInput(KNOWN.email.toUpperCase()),
    );

    expect(Object.keys(outcome).toSorted()).toEqual(['userId', 'wasFirstUser']);
    expect(outcome).toEqual({ userId: KNOWN.id, wasFirstUser: false });
    expect(users).toHaveLength(1);
    expect(insertsInto(statements, 'user')).toBe(0);
    expect(insertsInto(statements, 'verification')).toBe(1);
    expect(mail.sent.map((message) => message.to)).toEqual([KNOWN.email]);
  });

  it('sends the message only after the audited mutation has returned', async () => {
    const { tx } = fakeDatabase({ users: [KNOWN] });
    const events: string[] = [];

    await inviteUser(deps(tx, { events }), inviteInput());

    expect(events).toEqual(['committed', 'sent']);
  });
});

describe('resendSetPasswordLink guards (AUTH-04)', () => {
  it('refuses a caller without users:reset-password, records the denial and issues nothing', async () => {
    const { tx, statements } = fakeDatabase({ users: [KNOWN] });
    const recorder = fakeRecorder(tx, ROLES);
    const mail = recordingSender();

    await expect(
      resendSetPasswordLink(
        { recorder, mail, baseURL: BASE_URL },
        {
          email: KNOWN.email,
          actor: { userId: 'user-inviter', roleKey: 'no-reset' },
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(recorder.denied.map((denial) => denial.entry.permission)).toEqual([
      'users:reset-password',
    ]);
    expect(recorder.denied[0]?.entry.action).toBe('user.resend-set-password');
    expect(recorder.allowed).toEqual([]);
    expect(insertsInto(statements, 'verification')).toBe(0);
    expect(mail.sent).toEqual([]);
  });

  it('returns the same outcome for an unknown address as for a known one, and sends nothing for it', async () => {
    const known = fakeDatabase({ users: [KNOWN] });
    const knownMail = recordingSender();
    const unknown = fakeDatabase({ users: [KNOWN] });
    const unknownMail = recordingSender();

    const knownOutcome = await resendSetPasswordLink(
      { ...deps(known.tx), mail: knownMail },
      { email: KNOWN.email, actor: SUPERADMIN },
    );
    const unknownOutcome = await resendSetPasswordLink(
      { ...deps(unknown.tx), mail: unknownMail },
      { email: 'nobody.here@example.test', actor: SUPERADMIN },
    );

    expect(knownOutcome).toEqual({ delivered: true });
    expect(unknownOutcome).toEqual(knownOutcome);
    expect(knownMail.sent).toHaveLength(1);
    expect(unknownMail.sent).toEqual([]);
  });

  it('renders reset-password for a user who already has a credential, and set-password otherwise', async () => {
    const withCredential = fakeDatabase({
      users: [KNOWN],
      credentialUserIds: [KNOWN.id],
    });
    const withoutCredential = fakeDatabase({ users: [KNOWN] });
    const renderer = recordingRenderer();

    await resendSetPasswordLink(
      { ...deps(withCredential.tx), renderEmail: renderer.renderEmail },
      { email: KNOWN.email, actor: SUPERADMIN },
    );
    await resendSetPasswordLink(
      { ...deps(withoutCredential.tx), renderEmail: renderer.renderEmail },
      { email: KNOWN.email, actor: SUPERADMIN },
    );

    expect(renderer.calls.map((call) => call.kind)).toEqual([
      'reset-password',
      'set-password',
    ]);
  });
});

describe('InviteDeliveryError', () => {
  it('carries the created user id and names only the recipient domain', async () => {
    const { tx, users } = fakeDatabase({ users: [KNOWN] });
    const error = await caught(() =>
      inviteUser({ ...deps(tx), mail: rejectingSender() }, inviteInput()),
    );

    expect(error).toBeInstanceOf(InviteDeliveryError);
    const delivery = error as InviteDeliveryError;
    expect(delivery.name).toBe('InviteDeliveryError');
    expect(delivery.userId).toBe(users[1]?.id);
    expect(delivery.recipientDomain).toBe('example.test');
    expect(delivery.cause).toBeInstanceOf(MailSendError);
    expect(delivery.message).toContain('example.test');
    expect(users).toHaveLength(2);
  });

  it('never quotes the local part, the display name or the token in a thrown error', async () => {
    const renderer = recordingRenderer();
    const inviteFailure = fakeDatabase({ users: [KNOWN] });
    const resendFailure = fakeDatabase({
      users: [{ ...KNOWN, email: INVITEE_EMAIL, name: INVITEE_NAME }],
    });
    const writeFailure = fakeDatabase({
      users: [KNOWN],
      failUserInsert: true,
    });

    const errors = [
      await caught(() =>
        inviteUser(
          {
            ...deps(inviteFailure.tx),
            mail: rejectingSender(
              new Error(`relay refused ${INVITEE_EMAIL} (${INVITEE_NAME})`),
            ),
            renderEmail: renderer.renderEmail,
          },
          inviteInput(),
        ),
      ),
      await caught(() =>
        resendSetPasswordLink(
          {
            ...deps(resendFailure.tx),
            mail: rejectingSender(),
            renderEmail: renderer.renderEmail,
          },
          { email: INVITEE_EMAIL, actor: SUPERADMIN },
        ),
      ),
      await caught(() =>
        inviteUser(
          { ...deps(writeFailure.tx), renderEmail: renderer.renderEmail },
          inviteInput(),
        ),
      ),
      await caught(() =>
        inviteUser(deps(fakeDatabase().tx), { ...inviteInput(), name: '' }),
      ),
    ];

    expect(errors.every((error) => error instanceof Error)).toBe(true);
    const tokens = tokensOf(renderer.calls);
    expect(tokens).toHaveLength(2);
    for (const error of errors) {
      const chain = messageChain(error);
      expect(chain).not.toContain(LOCAL_PART);
      expect(chain).not.toContain(INVITEE_NAME);
      for (const token of tokens) {
        expect(chain).not.toContain(token);
      }
    }
  });
});
