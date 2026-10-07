/**
 * The setup screen's "Send test email" against real Postgres: it mails only
 * the stored address of the user the signed token names, is capped per token,
 * reports each outcome, and answers the host 404 to anything unproven.
 */
import { createServer } from 'node:net';
import { runMigrations } from '@plakboek/db';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { bootstrapInstallation } from '../../src/runtime/bootstrap.js';
import { closeAllDbs } from '../../src/runtime/db.js';
import { readRuntimeEnv } from '../../src/runtime/env.js';
import { createRuntime, type Runtime } from '../../src/runtime/runtime.js';
import { handleTestEmailPost } from '../../src/setup/handlers.js';
import {
  TEST_EMAIL_TOKEN_TTL_MS,
  createSendLimiter,
  createTestEmailToken,
} from '../../src/setup/token.js';
import type { PlakboekConfig } from '../../src/types.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const SECRET = 'test-email-secret-0123456789-abcdefghijklmn';
const ORIGIN = 'http://localhost:3000';
const STORED = 'ada@example.com';

/** A port nothing listens on: bound, read, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function post(
  fields: Record<string, string>,
  headers: Record<string, string> = { Origin: ORIGIN },
): Request {
  return new Request(`${ORIGIN}/cms/setup/test-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

describe('handleTestEmailPost', () => {
  let config: PlakboekConfig;
  let database: TestDatabase;
  let userId: string;
  let info: MockInstance<typeof console.info>;

  beforeAll(async () => {
    ({ default: config } = await import('../fixture-host/plakboek.config.ts'));
  });

  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations({ connectionString: database.connectionString });
    const bootstrapRuntime = runtimeWith({});
    ({ userId } = await bootstrapInstallation(bootstrapRuntime, {
      name: 'Ada Lovelace',
      email: STORED,
      password: 'correct horse battery staple',
    }));
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    info.mockRestore();
    await closeAllDbs();
    await database.drop();
  });

  function runtimeWith(extra: Record<string, string>): Runtime {
    const env = readRuntimeEnv({
      DATABASE_URL: database.connectionString,
      PLAKBOEK_URL: ORIGIN,
      PLAKBOEK_SECRET: SECRET,
      PLAKBOEK_MAIL_FROM: 'no-reply@example.test',
      ...extra,
    });
    return createRuntime({ config }, env);
  }

  function token(options: { user?: string; now?: number } = {}): string {
    return createTestEmailToken({
      secret: SECRET,
      userId: options.user ?? userId,
      homePublished: true,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  function printed(): string {
    return info.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('prints to the console in development, to the stored address only', async () => {
    const runtime = runtimeWith({});
    const response = await handleTestEmailPost(
      post({
        token: token(),
        to: 'attacker@example.com',
        email: 'attacker@example.com',
      }),
      runtime,
      createSendLimiter(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain(
      'No SMTP server is configured, so the email was printed to the server console instead.',
    );
    expect(body).toMatch(/role="status"/);
    expect(body).toContain('View your site');
    expect(printed()).toContain(`To: ${STORED}`);
    expect(printed()).not.toContain('attacker@example.com');
  });

  it('reports the production no-SMTP copy', async () => {
    const runtime = runtimeWith({ NODE_ENV: 'production' });
    const response = await handleTestEmailPost(
      post({ token: token() }),
      runtime,
      createSendLimiter(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(
      'No SMTP server is configured. Set the PLAKBOEK_SMTP_* variables to send email. Setup is complete either way.',
    );
    expect(body).toMatch(/role="alert"/);
    expect(info).not.toHaveBeenCalled();
  });

  it('reports the exact transport error when SMTP is unreachable', async () => {
    const port = await closedPort();
    const runtime = runtimeWith({
      PLAKBOEK_SMTP_HOST: '127.0.0.1',
      PLAKBOEK_SMTP_PORT: String(port),
      PLAKBOEK_SMTP_USER: 'mailer',
      PLAKBOEK_SMTP_PASS: 'smtp-pass-should-stay-secret',
    });
    const response = await handleTestEmailPost(
      post({ token: token() }),
      runtime,
      createSendLimiter(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('The test email could not be sent: ');
    expect(body).toContain('ECONNREFUSED');
    expect(body).toContain('Setup is complete either way.');
    expect(body).toMatch(/role="alert"/);
    expect(body).toContain('View your site');
    expect(body).not.toContain('smtp-pass-should-stay-secret');
  });

  it('answers the host 404 to a missing, forged or expired token', async () => {
    const runtime = runtimeWith({});
    const limiter = createSendLimiter();
    const expired = token({
      now: Date.now() - TEST_EMAIL_TOKEN_TTL_MS - 60_000,
    });
    const forged = `${token().split('.')[0] ?? ''}.AAAA`;

    const attempts: Record<string, string>[] = [
      {},
      { token: forged },
      { token: expired },
    ];
    for (const fields of attempts) {
      const response = await handleTestEmailPost(
        post(fields),
        runtime,
        limiter,
      );
      expect(response.status).toBe(404);
    }
    expect(info).not.toHaveBeenCalled();
  });

  it('answers the host 404 once a token has sent five times', async () => {
    const runtime = runtimeWith({});
    const limiter = createSendLimiter();
    const one = token();

    for (let sent = 0; sent < 5; sent += 1) {
      const ok = await handleTestEmailPost(
        post({ token: one }),
        runtime,
        limiter,
      );
      expect(ok.status).toBe(200);
    }
    info.mockClear();

    const sixth = await handleTestEmailPost(
      post({ token: one }),
      runtime,
      limiter,
    );
    expect(sixth.status).toBe(404);
    expect(info).not.toHaveBeenCalled();
  });

  it('answers the host 404 when the named user no longer exists', async () => {
    const runtime = runtimeWith({});
    const response = await handleTestEmailPost(
      post({ token: token({ user: 'no-such-user' }) }),
      runtime,
      createSendLimiter(),
    );
    expect(response.status).toBe(404);
    expect(info).not.toHaveBeenCalled();
  });

  it('answers 413 to oversized bodies before parsing and keeps the send unspent', async () => {
    const runtime = runtimeWith({});
    const limiter = createSendLimiter({ max: 1 });
    const one = token();
    const text = new URLSearchParams({
      token: one,
      pad: 'x'.repeat(16 * 1024),
    }).toString();
    const bytes = new TextEncoder().encode(text);
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
    };
    const url = `${ORIGIN}/cms/setup/test-email`;

    const declared = new Request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(bytes.byteLength) },
      body: text,
    });
    const chunked = new Request(url, {
      method: 'POST',
      headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const lying = new Request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': '64' },
      body: text,
    });

    for (const request of [declared, chunked, lying]) {
      const response = await handleTestEmailPost(request, runtime, limiter);
      expect(response.status).toBe(413);
    }
    expect(info).not.toHaveBeenCalled();

    const normal = await handleTestEmailPost(
      post({ token: one }),
      runtime,
      limiter,
    );
    expect(normal.status).toBe(200);
  });

  it('refuses a foreign origin with 403 before any work', async () => {
    const runtime = runtimeWith({});
    const response = await handleTestEmailPost(
      post({ token: token() }, { Origin: 'https://evil.example' }),
      runtime,
      createSendLimiter(),
    );
    expect(response.status).toBe(403);
    expect(info).not.toHaveBeenCalled();
  });
});
