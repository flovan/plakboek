import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SET_PASSWORD_TOKEN_TTL_SECONDS } from '../../src/config.js';
import {
  PASSWORD_LINK_PATHS,
  requestPasswordLink,
  type PasswordLinkPurpose,
  type RequestPasswordLinkDeps,
} from '../../src/credentials.js';
import { renderAuthEmail, type AuthEmailKind } from '../../src/email/render.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from '../../src/email/types.js';
import type { TokenDatabase } from '../../src/tokens.js';

const BASE_URL = 'https://cms.example.test';
const KNOWN = { id: 'user-known', email: 'known@example.test', name: 'Known' };

type Statement = { readonly sql: string; readonly params: unknown[] };

type FakeDatabase = {
  readonly db: TokenDatabase;
  readonly statements: Statement[];
};

/**
 * An in-memory stand-in for the database seam: a real Drizzle query builder
 * over a callback driver. It records every statement, answers the user
 * lookup from one known row, and runs a transaction callback on itself, so
 * a thrown callback simply propagates.
 */
function fakeDatabase(): FakeDatabase {
  const statements: Statement[] = [];
  const db = drizzle((query, params, method) => {
    statements.push({ sql: query, params });
    if (method === 'all' && query.includes('from "user"')) {
      const rows = params.includes(KNOWN.email)
        ? [[KNOWN.id, KNOWN.email, KNOWN.name]]
        : [];
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
  Object.defineProperty(db, 'transaction', {
    value: async (run: (tx: unknown) => Promise<unknown>) => await run(db),
  });
  return { db: db as unknown as TokenDatabase, statements };
}

function recordingSender(): MailSender & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

type RenderCall = {
  readonly kind: AuthEmailKind;
  readonly data: Record<string, string>;
};

function recordingRenderer(): {
  readonly renderEmail: NonNullable<RequestPasswordLinkDeps['renderEmail']>;
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

function countingProbe() {
  const counts = { tokens: 0, verificationQueries: 0 };
  return {
    counts,
    probe: {
      onTokenGenerated() {
        counts.tokens += 1;
      },
      onVerificationQuery() {
        counts.verificationQueries += 1;
      },
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestPasswordLink (AUTH-05, D-15)', () => {
  it('returns the single outcome for a known address and sends exactly one message', async () => {
    const { db } = fakeDatabase();
    const mail = recordingSender();

    const outcome = await requestPasswordLink(
      { db, mail, baseURL: BASE_URL },
      { email: KNOWN.email, purpose: 'reset-password' },
    );

    expect(outcome).toEqual({ delivered: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe(KNOWN.email);
  });

  it('resolves for a known address even when the send never settles', async () => {
    const { db } = fakeDatabase();
    let sendCalls = 0;
    const mail: MailSender = {
      send() {
        sendCalls += 1;
        return new Promise<void>(() => undefined);
      },
    };

    const settled = await Promise.race([
      requestPasswordLink(
        { db, mail, baseURL: BASE_URL },
        { email: KNOWN.email, purpose: 'reset-password' },
      ),
      new Promise<'timed out'>((resolve) =>
        setTimeout(() => resolve('timed out'), 1000),
      ),
    ]);

    expect(settled).toEqual({ delivered: true });
    expect(sendCalls).toBe(1);
  });

  it('reports a rejected send once through onDeliveryError and leaves no unhandled rejection', async () => {
    const { db } = fakeDatabase();
    const failure = new MailSendError(KNOWN.email);
    const mail: MailSender = { send: () => Promise.reject(failure) };
    const reported: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const outcome = await requestPasswordLink(
        {
          db,
          mail,
          baseURL: BASE_URL,
          onDeliveryError: (error) => {
            reported.push(error);
          },
        },
        { email: KNOWN.email, purpose: 'reset-password' },
      );
      await flushMicrotasks();
      await flushMicrotasks();

      expect(outcome).toEqual({ delivered: true });
      expect(reported).toEqual([failure]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('logs one domain-only line when no onDeliveryError hook is supplied', async () => {
    const { db } = fakeDatabase();
    const mail: MailSender = {
      send: () => Promise.reject(new MailSendError(KNOWN.email)),
    };
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await requestPasswordLink(
      { db, mail, baseURL: BASE_URL },
      { email: KNOWN.email, purpose: 'reset-password' },
    );
    await flushMicrotasks();

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('example.test');
    expect(line).not.toContain('known@');
  });

  it('contains an onDeliveryError hook that throws', async () => {
    const { db } = fakeDatabase();
    const mail: MailSender = {
      send: () => Promise.reject(new MailSendError(KNOWN.email)),
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const outcome = await requestPasswordLink(
        {
          db,
          mail,
          baseURL: BASE_URL,
          onDeliveryError: () => {
            throw new Error('hook broke');
          },
        },
        { email: KNOWN.email, purpose: 'reset-password' },
      );
      await flushMicrotasks();
      await flushMicrotasks();

      expect(outcome).toEqual({ delivered: true });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('returns the identical outcome for an unknown address and sends nothing', async () => {
    const known = fakeDatabase();
    const unknown = fakeDatabase();
    const mail = recordingSender();

    const knownOutcome = await requestPasswordLink(
      { db: known.db, mail: recordingSender(), baseURL: BASE_URL },
      { email: KNOWN.email, purpose: 'reset-password' },
    );
    const unknownOutcome = await requestPasswordLink(
      { db: unknown.db, mail, baseURL: BASE_URL },
      { email: 'nobody@example.test', purpose: 'reset-password' },
    );

    expect(unknownOutcome).toEqual(knownOutcome);
    expect(Object.keys(unknownOutcome)).toEqual(Object.keys(knownOutcome));
    expect(mail.sent).toEqual([]);
  });

  it('performs the same work for a known and an unknown address', async () => {
    const known = fakeDatabase();
    const unknown = fakeDatabase();
    const knownProbe = countingProbe();
    const unknownProbe = countingProbe();

    await requestPasswordLink(
      {
        db: known.db,
        mail: recordingSender(),
        baseURL: BASE_URL,
        probe: knownProbe.probe,
      },
      { email: KNOWN.email, purpose: 'reset-password' },
    );
    await requestPasswordLink(
      {
        db: unknown.db,
        mail: recordingSender(),
        baseURL: BASE_URL,
        probe: unknownProbe.probe,
      },
      { email: 'nobody@example.test', purpose: 'reset-password' },
    );

    expect(knownProbe.counts).toEqual({ tokens: 1, verificationQueries: 1 });
    expect(unknownProbe.counts).toEqual(knownProbe.counts);
    // The same statements, in the same order, reach the database.
    expect(unknown.statements.map((statement) => statement.sql)).toEqual(
      known.statements.map((statement) => statement.sql),
    );
    expect(
      unknown.statements.filter((statement) =>
        statement.sql.includes('"verification"'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['no at sign', 'not-an-address'],
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['two at signs', 'a@@b'],
  ])(
    'treats a malformed address (%s) exactly like an unknown one',
    async (_label, email) => {
      const reference = fakeDatabase();
      const malformed = fakeDatabase();
      const referenceProbe = countingProbe();
      const malformedProbe = countingProbe();
      const mail = recordingSender();

      await requestPasswordLink(
        {
          db: reference.db,
          mail: recordingSender(),
          baseURL: BASE_URL,
          probe: referenceProbe.probe,
        },
        { email: 'nobody@example.test', purpose: 'reset-password' },
      );
      const outcome = await requestPasswordLink(
        {
          db: malformed.db,
          mail,
          baseURL: BASE_URL,
          probe: malformedProbe.probe,
        },
        { email, purpose: 'reset-password' },
      );

      expect(outcome).toEqual({ delivered: true });
      expect(mail.sent).toEqual([]);
      expect(malformedProbe.counts).toEqual({
        tokens: 1,
        verificationQueries: 1,
      });
      expect(malformedProbe.counts).toEqual(referenceProbe.counts);
      expect(malformed.statements.map((statement) => statement.sql)).toEqual(
        reference.statements.map((statement) => statement.sql),
      );
    },
  );

  it('builds the link from the base URL, with the token exactly once, whatever the trailing slash', async () => {
    const urls: string[] = [];
    for (const baseURL of [BASE_URL, `${BASE_URL}/`]) {
      const { db } = fakeDatabase();
      const renderer = recordingRenderer();
      await requestPasswordLink(
        {
          db,
          mail: recordingSender(),
          renderEmail: renderer.renderEmail,
          baseURL,
        },
        { email: KNOWN.email, purpose: 'reset-password' },
      );
      urls.push(renderer.calls[0]?.data.url ?? '');
    }

    const [first = '', second = ''] = urls;
    const token = tokenOf(first);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(first.split(token)).toHaveLength(2);
    const parsed = new URL(first);
    expect(parsed.origin).toBe(BASE_URL);
    expect(parsed.pathname).toBe(PASSWORD_LINK_PATHS['reset-password']);
    const normalise = (url: string) => url.replace(tokenOf(url), '<token>');
    expect(normalise(second)).toBe(normalise(first));
  });

  it('emails the token whose digest it stored', async () => {
    const { db, statements } = fakeDatabase();
    const renderer = recordingRenderer();

    await requestPasswordLink(
      {
        db,
        mail: recordingSender(),
        renderEmail: renderer.renderEmail,
        baseURL: BASE_URL,
      },
      { email: KNOWN.email, purpose: 'set-password' },
    );

    const token = tokenOf(renderer.calls[0]?.data.url ?? '');
    const digest = createHash('sha256').update(token).digest('base64url');
    const inserted = statements.find((statement) =>
      statement.sql.startsWith('insert into "verification"'),
    );
    expect(inserted?.params).toContain(`set-password:${digest}`);
    expect(inserted?.params).not.toContain(token);
  });

  it.each([
    ['set-password', 'set-password'],
    ['reset-password', 'reset-password'],
  ] satisfies [PasswordLinkPurpose, AuthEmailKind][])(
    'renders the %s template for the %s purpose, with the policy window',
    async (purpose, kind) => {
      const { db } = fakeDatabase();
      const renderer = recordingRenderer();
      const mail = recordingSender();

      await requestPasswordLink(
        { db, mail, renderEmail: renderer.renderEmail, baseURL: BASE_URL },
        { email: KNOWN.email, purpose },
      );

      expect(renderer.calls.map((call) => call.kind)).toEqual([kind]);
      expect(renderer.calls[0]?.data.expiresInHours).toBe(
        String(SET_PASSWORD_TOKEN_TTL_SECONDS / 3600),
      );
      expect(new URL(renderer.calls[0]?.data.url ?? '').pathname).toBe(
        PASSWORD_LINK_PATHS[purpose],
      );
      expect(mail.sent).toHaveLength(1);
    },
  );

  it.each(['magic-link', 'two-factor-code', 'SET-PASSWORD', ''])(
    'throws for the unsupported purpose %j before doing any work',
    async (purpose) => {
      const { db, statements } = fakeDatabase();
      const { counts, probe } = countingProbe();
      const mail = recordingSender();

      await expect(
        requestPasswordLink(
          { db, mail, baseURL: BASE_URL, probe },
          // The purpose is the library's own argument, so a wrong one is a
          // programming error worth a loud failure.
          { email: KNOWN.email, purpose: purpose as PasswordLinkPurpose },
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(statements).toEqual([]);
      expect(counts).toEqual({ tokens: 0, verificationQueries: 0 });
      expect(mail.sent).toEqual([]);
    },
  );
});
