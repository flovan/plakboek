/**
 * `plakboek mail:test` as a spawned process: the development console path,
 * the production no-SMTP refusal, an unreachable SMTP server's exact error,
 * and the usage rules. No database is involved.
 */
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { runCli } from './cli-helpers.js';

const base = {
  PLAKBOEK_URL: 'http://localhost:3000',
  PLAKBOEK_MAIL_FROM: 'no-reply@example.test',
} as const;

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

describe('plakboek mail:test', () => {
  it('prints the message to the console in development without SMTP', async () => {
    const result = await runCli(['mail:test', 'ops@example.com'], {
      env: base,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('To: ops@example.com');
    expect(result.stdout).toContain('Subject: Plakboek delivery test: ');
    expect(result.stdout).toContain(
      'No SMTP server is configured, so the email was printed above instead.',
    );
    expect(result.stderr).toBe('');
  });

  it('refuses in production without SMTP', async () => {
    const result = await runCli(['mail:test', 'ops@example.com'], {
      env: { ...base, NODE_ENV: 'production' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: No SMTP server is configured. Set the PLAKBOEK_SMTP_* variables.',
    );
  });

  it('prints the exact transport error and never the SMTP password', async () => {
    const port = await closedPort();
    const result = await runCli(['mail:test', 'ops@example.com'], {
      env: {
        ...base,
        PLAKBOEK_SMTP_HOST: '127.0.0.1',
        PLAKBOEK_SMTP_PORT: String(port),
        PLAKBOEK_SMTP_USER: 'mailer',
        PLAKBOEK_SMTP_PASS: 'smtp-pass-should-stay-secret',
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: Could not send the test email: ');
    expect(result.stderr).toContain('ECONNREFUSED');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain(
      'smtp-pass-should-stay-secret',
    );
  });

  it('exits 2 with usage for a missing or invalid address', async () => {
    for (const args of [['mail:test'], ['mail:test', 'not-an-address']]) {
      const result = await runCli(args, { env: base });
      expect([args.join(' '), result.code]).toEqual([args.join(' '), 2]);
      expect(result.stderr).toContain('Usage:');
    }
  });

  it('lists the environment problems when PLAKBOEK_URL is missing', async () => {
    const result = await runCli(['mail:test', 'ops@example.com'], {
      env: { PLAKBOEK_MAIL_FROM: base.PLAKBOEK_MAIL_FROM },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PLAKBOEK_URL');
    expect(result.stderr).not.toContain('DATABASE_URL');
    expect(result.stderr).not.toContain('PLAKBOEK_SECRET');
  });

  it('asks for PLAKBOEK_MAIL_FROM when no sender address is set', async () => {
    const result = await runCli(['mail:test', 'ops@example.com'], {
      env: { PLAKBOEK_URL: base.PLAKBOEK_URL },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Set PLAKBOEK_MAIL_FROM.');
  });
});
