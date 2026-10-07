import { describe, expect, it } from 'vitest';
import {
  PlakboekEnvError,
  SECRET_GENERATION_COMMAND,
  readMailEnv,
  readRuntimeEnv,
} from '../../src/runtime/env.js';

const SECRET = 'a'.repeat(32);

const valid = {
  DATABASE_URL: 'postgres://user:hunter2@db.internal:5432/app',
  PLAKBOEK_URL: 'https://example.com',
  PLAKBOEK_SECRET: SECRET,
} as const;

function failure(source: Record<string, string | undefined>): PlakboekEnvError {
  let caught: unknown;
  try {
    readRuntimeEnv(source);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof PlakboekEnvError)) {
    throw new Error('expected readRuntimeEnv to throw a PlakboekEnvError');
  }
  return caught;
}

function variables(error: PlakboekEnvError): string[] {
  return error.issues.map((issue) => issue.variable);
}

describe('readRuntimeEnv', () => {
  it('lists every missing required variable at once', () => {
    const error = failure({});
    expect(variables(error)).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'PLAKBOEK_URL',
        'PLAKBOEK_SECRET',
      ]),
    );
    expect(error.message).toContain('[@plakboek/core] invalid environment:');
  });

  it('prints the generation command for a missing secret, never a value', () => {
    const error = failure({ ...valid, PLAKBOEK_SECRET: undefined });
    expect(SECRET_GENERATION_COMMAND).toContain('randomBytes(32)');
    expect(error.message).toContain(SECRET_GENERATION_COMMAND);
    expect(error.message).toContain('PLAKBOEK_SECRET is not set');
  });

  it('refuses a 31-character secret and accepts 32, in development too', () => {
    const short = failure({
      ...valid,
      PLAKBOEK_SECRET: 'a'.repeat(31),
      NODE_ENV: 'development',
    });
    expect(variables(short)).toEqual(['PLAKBOEK_SECRET']);
    expect(short.message).toContain(SECRET_GENERATION_COMMAND);
    expect(short.message).not.toContain('a'.repeat(31));

    const env = readRuntimeEnv({ ...valid, NODE_ENV: 'development' });
    expect(env.secret).toBe(SECRET);
    expect(env.production).toBe(false);
  });

  it('refuses a non-postgres DATABASE_URL without echoing it', () => {
    const error = failure({ ...valid, DATABASE_URL: 'mysql://x' });
    expect(variables(error)).toEqual(['DATABASE_URL']);
    expect(error.message).not.toContain('mysql://x');
    expect(JSON.stringify(error.issues)).not.toContain('mysql://x');
  });

  it('accepts postgres and postgresql schemes and an optional migration URL', () => {
    const env = readRuntimeEnv({
      ...valid,
      DATABASE_URL: 'postgresql://u:p@h/db',
      DATABASE_MIGRATION_URL: 'postgres://u:p@h:5433/db',
    });
    expect(env.databaseUrl).toBe('postgresql://u:p@h/db');
    expect(env.migrationDatabaseUrl).toBe('postgres://u:p@h:5433/db');

    const bad = failure({ ...valid, DATABASE_MIGRATION_URL: 'http://nope' });
    expect(variables(bad)).toEqual(['DATABASE_MIGRATION_URL']);
    expect(bad.message).not.toContain('http://nope');
  });

  it.each(['example.com', 'ftp://example.com', 'https://example.com/sub'])(
    'refuses PLAKBOEK_URL %s',
    (value) => {
      const error = failure({ ...valid, PLAKBOEK_URL: value });
      expect(variables(error)).toEqual(['PLAKBOEK_URL']);
      expect(error.message).not.toContain(value);
    },
  );

  it('normalises PLAKBOEK_URL to an origin without a trailing slash', () => {
    expect(
      readRuntimeEnv({ ...valid, PLAKBOEK_URL: 'https://example.com/' })
        .siteUrl,
    ).toBe('https://example.com');
    expect(
      readRuntimeEnv({ ...valid, PLAKBOEK_URL: 'http://localhost:3000' })
        .siteUrl,
    ).toBe('http://localhost:3000');
  });

  it('refuses a query or fragment on PLAKBOEK_URL', () => {
    expect(
      variables(failure({ ...valid, PLAKBOEK_URL: 'https://a.com/?x=1' })),
    ).toEqual(['PLAKBOEK_URL']);
    expect(
      variables(failure({ ...valid, PLAKBOEK_URL: 'https://a.com/#x' })),
    ).toEqual(['PLAKBOEK_URL']);
  });

  it('validates PLAKBOEK_BUILD_ID', () => {
    expect(
      variables(failure({ ...valid, PLAKBOEK_BUILD_ID: 'abc def' })),
    ).toEqual(['PLAKBOEK_BUILD_ID']);
    expect(
      readRuntimeEnv({ ...valid, PLAKBOEK_BUILD_ID: 'a1b2c3' }).buildId,
    ).toBe('a1b2c3');
    expect(readRuntimeEnv(valid).buildId).toBeUndefined();
  });

  it('reads production from NODE_ENV only', () => {
    expect(
      readRuntimeEnv({ ...valid, NODE_ENV: 'production' }).production,
    ).toBe(true);
    expect(readRuntimeEnv({ ...valid, NODE_ENV: 'test' }).production).toBe(
      false,
    );
    expect(readRuntimeEnv(valid).production).toBe(false);
  });

  describe('SMTP', () => {
    it('is absent when the host is blank', () => {
      expect(readRuntimeEnv(valid).smtp).toBeUndefined();
      expect(
        readRuntimeEnv({ ...valid, PLAKBOEK_SMTP_HOST: '  ' }).smtp,
      ).toBeUndefined();
    });

    it('parses host, port, secure, user and pass', () => {
      const env = readRuntimeEnv({
        ...valid,
        PLAKBOEK_SMTP_HOST: 'smtp.example.com',
        PLAKBOEK_SMTP_PORT: '465',
        PLAKBOEK_SMTP_SECURE: 'true',
        PLAKBOEK_SMTP_USER: 'mailer',
        PLAKBOEK_SMTP_PASS: 'pw',
        PLAKBOEK_MAIL_FROM: 'noreply@example.com',
      });
      expect(env.smtp).toEqual({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        user: 'mailer',
        pass: 'pw',
      });
      expect(env.mailFrom).toBe('noreply@example.com');
    });

    it("treats 'false' as false and leaves port and auth unset when blank", () => {
      const env = readRuntimeEnv({
        ...valid,
        PLAKBOEK_SMTP_HOST: 'smtp.example.com',
        PLAKBOEK_SMTP_SECURE: 'false',
        PLAKBOEK_SMTP_PORT: '',
      });
      expect(env.smtp).toEqual({ host: 'smtp.example.com', secure: false });
    });

    it.each([
      ['PLAKBOEK_SMTP_PORT', 'x'],
      ['PLAKBOEK_SMTP_PORT', '70000'],
      ['PLAKBOEK_SMTP_SECURE', 'yes'],
    ])('refuses %s=%s without echoing the value', (variable, value) => {
      const error = failure({
        ...valid,
        PLAKBOEK_SMTP_HOST: 'smtp.example.com',
        [variable]: value,
      });
      expect(variables(error)).toEqual([variable]);
      expect(error.message).not.toContain(`"${value}"`);
    });

    it('refuses a user without a password and the reverse', () => {
      const base = { ...valid, PLAKBOEK_SMTP_HOST: 'smtp.example.com' };
      expect(
        variables(failure({ ...base, PLAKBOEK_SMTP_USER: 'mailer' })),
      ).toEqual(['PLAKBOEK_SMTP_PASS']);
      expect(variables(failure({ ...base, PLAKBOEK_SMTP_PASS: 'pw' }))).toEqual(
        ['PLAKBOEK_SMTP_USER'],
      );
    });
  });
});

describe('readMailEnv', () => {
  it('needs only the public url: no database url and no secret', () => {
    const env = readMailEnv({
      PLAKBOEK_URL: 'https://example.com/',
      PLAKBOEK_MAIL_FROM: ' no-reply@example.com ',
      NODE_ENV: 'production',
    });
    expect(env).toEqual({
      siteUrl: 'https://example.com',
      mailFrom: 'no-reply@example.com',
      production: true,
    });
  });

  it('reads the SMTP group the same way the runtime does', () => {
    const env = readMailEnv({
      PLAKBOEK_URL: 'https://example.com',
      PLAKBOEK_SMTP_HOST: 'smtp.example.com',
      PLAKBOEK_SMTP_PORT: '465',
      PLAKBOEK_SMTP_SECURE: 'true',
      PLAKBOEK_SMTP_USER: 'mailer',
      PLAKBOEK_SMTP_PASS: 'pw',
    });
    expect(env.smtp).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'mailer',
      pass: 'pw',
    });
    expect(env.production).toBe(false);
  });

  it('collects every problem in the variables it reads, never a value', () => {
    let caught: unknown;
    try {
      readMailEnv({
        PLAKBOEK_SMTP_HOST: 'smtp.example.com',
        PLAKBOEK_SMTP_PORT: 'nope',
        PLAKBOEK_SMTP_USER: 'mailer',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlakboekEnvError);
    expect(variables(caught as PlakboekEnvError)).toEqual(
      expect.arrayContaining([
        'PLAKBOEK_URL',
        'PLAKBOEK_SMTP_PORT',
        'PLAKBOEK_SMTP_PASS',
      ]),
    );
    expect((caught as PlakboekEnvError).message).not.toContain('mailer');
  });
});
