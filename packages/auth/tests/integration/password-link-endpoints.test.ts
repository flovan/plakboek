import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import {
  createAuth,
  type Auth,
  type CreateAuthOptions,
} from '../../src/config.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { createTestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'password-link-test-secret-with-at-least-32-characters';
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a much newer passphrase';
const SHORT_PASSWORD = 'six pw';
const KNOWN = 'ada@example.com';
const UNKNOWN = 'nobody@example.com';
const REQUEST_PATH = '/api/auth/plakboek/password-link/request';
const COMPLETE_PATH = '/api/auth/plakboek/password-link/complete';
const LINK_PATTERN = /https?:\/\/\S+[?&]token=[\w-]+/;
const FULL_LINK_PATTERN = /https?:\/\/[^\s\]]+[?&]token=[^\s\]]+/;

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
 * with one email-and-password user at `KNOWN`. */
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
    const created = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: KNOWN,
      name: 'Ada',
      roleKey: 'editor',
    });
    const context = await auth.$context;
    await context.internalAdapter.linkAccount({
      userId: created.userId,
      providerId: 'credential',
      accountId: created.userId,
      password: await context.password.hash(OLD_PASSWORD),
    });
    await body({ auth, handle, mail });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await testDatabase.drop();
  }
}

/** Lets every detached promise chain settle: the link send is dispatched
 * without being awaited (D-15). */
async function flushDetached(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function post(
  auth: Auth,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return auth.handler(
    new Request(new URL(path, BASE_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

type Answer = { readonly status: number; readonly text: string };

async function answerOf(response: Response): Promise<Answer> {
  return { status: response.status, text: await response.text() };
}

function requestLink(auth: Auth, email: string, headers = {}) {
  return post(auth, REQUEST_PATH, { email }, headers);
}

function completeLink(
  auth: Auth,
  token: string,
  newPassword: string,
  purpose = 'reset-password',
) {
  return post(auth, COMPLETE_PATH, { purpose, token, newPassword });
}

function tokenFrom(message: MailMessage | undefined): string {
  const link = LINK_PATTERN.exec(message?.text ?? '')?.[0];
  expect(link).toBeDefined();
  return new URL(link ?? '').searchParams.get('token') ?? '';
}

function signIn(auth: Auth, password: string) {
  return post(auth, '/api/auth/sign-in/email', { email: KNOWN, password });
}

describe('forgot password over HTTP (T-07-08)', () => {
  it('answers a registered and an unregistered address identically and mails only the registered one', async () => {
    await withFixture(async ({ auth, mail }) => {
      const known = await answerOf(await requestLink(auth, KNOWN));
      await flushDetached();
      const sentForKnown = mail.sent.length;
      const unknown = await answerOf(await requestLink(auth, UNKNOWN));
      await flushDetached();

      expect(known).toEqual({ status: 200, text: '{"status":true}' });
      expect(unknown).toEqual(known);
      expect(sentForKnown).toBe(1);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(KNOWN);
    });
  });

  it('answers a malformed body with one generic 400', async () => {
    await withFixture(async ({ auth, mail }) => {
      const bodies: unknown[] = [
        {},
        { email: 42 },
        { email: 'a'.repeat(321) },
        { email: KNOWN, next: 7 },
        { email: KNOWN, next: '/'.padEnd(2049, 'a') },
      ];
      const answers = [];
      for (const body of bodies) {
        answers.push(await answerOf(await post(auth, REQUEST_PATH, body)));
      }
      await flushDetached();

      for (const answer of answers) {
        expect(answer.status).toBe(400);
        expect(JSON.parse(answer.text)).toMatchObject({
          code: 'INVALID_REQUEST',
        });
      }
      expect(mail.sent).toHaveLength(0);
    });
  });
});

/** The whole link, every query parameter included. */
function linkOf(message: MailMessage | undefined): URL {
  const link = FULL_LINK_PATTERN.exec(message?.text ?? '')?.[0];
  expect(link).toBeDefined();
  return new URL(link ?? '');
}

describe('next on emailed links (D-09, D-11)', () => {
  async function linkFor(next: unknown): Promise<URL> {
    let link = new URL(BASE_URL);
    await withFixture(async ({ auth, mail }) => {
      const response = await post(auth, REQUEST_PATH, { email: KNOWN, next });
      expect(response.status).toBe(200);
      await flushDetached();
      link = linkOf(mail.sent[0]);
    });
    return link;
  }

  it('carries a same-origin path next to the token', async () => {
    const link = await linkFor('/about');
    expect(link.pathname).toBe('/cms/reset-password');
    expect(link.searchParams.get('token')).toBeTruthy();
    expect(link.searchParams.get('next')).toBe('/about');
    expect(link.search).toContain('next=%2Fabout');
  });

  it('strips _edit from the carried path', async () => {
    const link = await linkFor('/about?_edit=1&a=b');
    expect(link.searchParams.get('next')).toBe('/about?a=b');
  });

  it('leaves next off for anything that is not a same-origin path', async () => {
    for (const hostile of ['//evil.test', 'https://evil.test/x', '/cms/x']) {
      const link = await linkFor(hostile);
      expect(link.searchParams.has('next')).toBe(false);
      expect(link.searchParams.get('token')).toBeTruthy();
    }
  });

  it('leaves next off when none is given', async () => {
    const link = await linkFor(undefined);
    expect(link.searchParams.has('next')).toBe(false);
  });
});

describe('completing a link over HTTP', () => {
  it('sets the new password from the emailed token, once', async () => {
    await withFixture(async ({ auth, mail }) => {
      await requestLink(auth, KNOWN);
      await flushDetached();
      const token = tokenFrom(mail.sent[0]);

      const done = await answerOf(
        await completeLink(auth, token, NEW_PASSWORD),
      );
      expect(done).toEqual({ status: 200, text: '{"status":true}' });

      expect((await signIn(auth, NEW_PASSWORD)).status).toBe(200);
      expect((await signIn(auth, OLD_PASSWORD)).status).not.toBe(200);

      const reused = await answerOf(
        await completeLink(auth, token, 'yet another passphrase'),
      );
      expect(reused.status).toBe(400);
      expect(JSON.parse(reused.text)).toMatchObject({ code: 'INVALID_LINK' });
    });
  });

  it('answers a garbage token with the same body as a spent one', async () => {
    await withFixture(async ({ auth, mail }) => {
      await requestLink(auth, KNOWN);
      await flushDetached();
      const token = tokenFrom(mail.sent[0]);
      await completeLink(auth, token, NEW_PASSWORD);

      const spent = await answerOf(
        await completeLink(auth, token, NEW_PASSWORD),
      );
      const garbage = await answerOf(
        await completeLink(auth, 'not-a-real-token', NEW_PASSWORD),
      );
      const wrongPurpose = await answerOf(
        await completeLink(auth, token, NEW_PASSWORD, 'set-password'),
      );

      expect(garbage).toEqual(spent);
      expect(wrongPurpose).toEqual(spent);
      expect(JSON.parse(spent.text)).toMatchObject({ code: 'INVALID_LINK' });
    });
  });

  it('refuses a too-short password without spending the link', async () => {
    await withFixture(async ({ auth, mail }) => {
      await requestLink(auth, KNOWN);
      await flushDetached();
      const token = tokenFrom(mail.sent[0]);

      const short = await answerOf(
        await completeLink(auth, token, SHORT_PASSWORD),
      );
      expect(short.status).toBe(400);
      expect(JSON.parse(short.text)).toMatchObject({
        code: 'PASSWORD_TOO_SHORT',
      });

      const done = await completeLink(auth, token, NEW_PASSWORD);
      expect(done.status).toBe(200);
      expect((await signIn(auth, NEW_PASSWORD)).status).toBe(200);
    });
  });

  it('answers a malformed body without reading further', async () => {
    await withFixture(async ({ auth }) => {
      const badPurpose = await post(auth, COMPLETE_PATH, {
        purpose: 'sign-in',
        token: 'x',
        newPassword: NEW_PASSWORD,
      });
      expect(badPurpose.status).toBe(400);
      expect(JSON.parse(await badPurpose.text())).toMatchObject({
        code: 'INVALID_REQUEST',
      });

      const longToken = await post(auth, COMPLETE_PATH, {
        purpose: 'reset-password',
        token: 'x'.repeat(513),
        newPassword: NEW_PASSWORD,
      });
      expect(longToken.status).toBe(400);
      expect(JSON.parse(await longToken.text())).toMatchObject({
        code: 'INVALID_LINK',
      });
    });
  });
});

/** better-auth skips its origin checks when it detects a test environment,
 * which would make these cases vacuous. The setting is read from the shared
 * context on every request, so it is switched back to the production
 * behaviour for the instance under test. */
async function enforceOriginChecks(auth: Auth): Promise<void> {
  const context = await auth.$context;
  context.skipOriginCheck = false;
}

describe('origin check', () => {
  it('refuses a foreign Origin on both endpoints and does nothing', async () => {
    await withFixture(async ({ auth, mail }) => {
      await enforceOriginChecks(auth);
      const foreign = { origin: 'https://evil.example' };
      const requested = await post(
        auth,
        REQUEST_PATH,
        { email: KNOWN },
        foreign,
      );
      const completed = await post(
        auth,
        COMPLETE_PATH,
        { purpose: 'reset-password', token: 'x', newPassword: NEW_PASSWORD },
        foreign,
      );
      await flushDetached();

      expect(requested.status).toBe(403);
      expect(completed.status).toBe(403);
      expect(mail.sent).toHaveLength(0);
    });
  });

  it('accepts the installation origin with the check enforced', async () => {
    await withFixture(async ({ auth, mail }) => {
      await enforceOriginChecks(auth);
      const response = await requestLink(auth, KNOWN);
      await flushDetached();

      expect(response.status).toBe(200);
      expect(mail.sent).toHaveLength(1);
    });
  });

  it('refuses a cross-site navigation', async () => {
    await withFixture(async ({ auth, mail }) => {
      await enforceOriginChecks(auth);
      const response = await post(
        auth,
        REQUEST_PATH,
        { email: KNOWN },
        {
          origin: BASE_URL,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        },
      );
      await flushDetached();

      expect(response.status).toBe(403);
      expect(mail.sent).toHaveLength(0);
    });
  });
});

describe('rate limits (T-07-07, closes AR-02-02 for the reset path)', () => {
  it('answers the fourth request step within 60 seconds with 429', async () => {
    await withFixture(
      async ({ auth }) => {
        const client = { 'x-forwarded-for': '203.0.113.10' };
        const statuses: number[] = [];
        for (let step = 0; step < 4; step += 1) {
          statuses.push((await requestLink(auth, KNOWN, client)).status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);

        // A different client keeps its own allowance.
        const other = await requestLink(auth, KNOWN, {
          'x-forwarded-for': '203.0.113.11',
        });
        expect(other.status).toBe(200);
      },
      { rateLimitEnabled: true },
    );
  });

  it('keys the limit on the client behind a trusted proxy chain, not on the proxy', async () => {
    await withFixture(
      async ({ auth }) => {
        const behindProxy = (client: string) => ({
          'x-forwarded-for': `${client}, 10.0.0.5`,
        });
        const statuses: number[] = [];
        for (let step = 0; step < 4; step += 1) {
          statuses.push(
            (await requestLink(auth, KNOWN, behindProxy('203.0.113.30')))
              .status,
          );
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
        const other = await requestLink(
          auth,
          KNOWN,
          behindProxy('203.0.113.31'),
        );
        expect(other.status).toBe(200);
      },
      { rateLimitEnabled: true, trustedProxies: ['10.0.0.0/24'] },
    );
  });

  it('without trustedProxies a multi-hop header has no client address, so everyone shares one allowance', async () => {
    await withFixture(
      async ({ auth }) => {
        const behindProxy = (client: string) => ({
          'x-forwarded-for': `${client}, 10.0.0.5`,
        });
        const statuses: number[] = [];
        for (let step = 0; step < 3; step += 1) {
          statuses.push(
            (await requestLink(auth, KNOWN, behindProxy('203.0.113.50')))
              .status,
          );
        }
        // A different client is already refused: this is the denial of
        // service `trustedProxies` exists to prevent.
        statuses.push(
          (await requestLink(auth, KNOWN, behindProxy('203.0.113.51'))).status,
        );
        expect(statuses).toEqual([200, 200, 200, 429]);
      },
      { rateLimitEnabled: true },
    );
  });

  it('reads the client from the header the proxy sets when ipAddressHeaders names it', async () => {
    await withFixture(
      async ({ auth }) => {
        const client = { 'cf-connecting-ip': '203.0.113.40' };
        const statuses: number[] = [];
        for (let step = 0; step < 4; step += 1) {
          statuses.push((await requestLink(auth, KNOWN, client)).status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
        const other = await requestLink(auth, KNOWN, {
          'cf-connecting-ip': '203.0.113.41',
        });
        expect(other.status).toBe(200);
      },
      { rateLimitEnabled: true, ipAddressHeaders: ['cf-connecting-ip'] },
    );
  });

  it('allows ten complete steps and answers the eleventh with 429', async () => {
    await withFixture(
      async ({ auth }) => {
        const client = { 'x-forwarded-for': '203.0.113.20' };
        const statuses: number[] = [];
        for (let step = 0; step < 11; step += 1) {
          const response = await post(
            auth,
            COMPLETE_PATH,
            {
              purpose: 'reset-password',
              token: 'nope',
              newPassword: NEW_PASSWORD,
            },
            client,
          );
          statuses.push(response.status);
        }
        expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(
          true,
        );
        expect(statuses[10]).toBe(429);
      },
      { rateLimitEnabled: true },
    );
  });
});
