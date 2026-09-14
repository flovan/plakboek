import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@plakboek/db';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import { describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/config.js';
import type { MailMessage, MailSender } from '../../src/email/types.js';
import { createUserWithRole } from '../../src/first-user.js';
import { createTestDatabase } from './test-database.js';

const BASE_URL = 'http://localhost:3000';
const SECRET = 'two-factor-test-secret-with-at-least-32-characters';
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'ada@example.com';
const SESSION_COOKIE = 'better-auth.session_token';
const CHALLENGE_COOKIE = 'better-auth.two_factor';
const LOCK_DURATION_MS = 900 * 1000;
const TOLERANCE_MS = 5000;
const TOTP_PERIOD_SECONDS = 30;

const roles = defineRoles(defaultRoles);

type RecordingSender = MailSender & { readonly sent: MailMessage[] };

type Fixture = {
  readonly auth: Auth;
  readonly handle: Db;
  readonly mail: RecordingSender;
  readonly userId: string;
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
 * with one email-and-password user at `EMAIL`. */
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
    const created = await createUserWithRole(handle.db, {
      id: randomUUID(),
      email: EMAIL,
      name: 'Ada',
      roleKey: 'editor',
    });
    const context = await auth.$context;
    await context.internalAdapter.linkAccount({
      userId: created.userId,
      providerId: 'credential',
      accountId: created.userId,
      password: await context.password.hash(PASSWORD),
    });
    await body({ auth, handle, mail, userId: created.userId });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await testDatabase.drop();
  }
}

function cookieHeader(headers: Headers, name: string): Headers {
  const pair = headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .find((candidate) => candidate.startsWith(`${name}=`));
  expect(pair).toBeDefined();
  return new Headers({ cookie: pair ?? '' });
}

async function signIn(auth: Auth) {
  return await auth.api.signInEmail({
    body: { email: EMAIL, password: PASSWORD },
    returnHeaders: true,
  });
}

/** Signs in without two-factor and returns the session cookie. */
async function signedInSession(auth: Auth): Promise<Headers> {
  const { headers } = await signIn(auth);
  return cookieHeader(headers, SESSION_COOKIE);
}

/** Signs in a two-factor user and returns the pending challenge cookie. */
async function challenge(auth: Auth): Promise<Headers> {
  const { response, headers } = await signIn(auth);
  expect(response).toMatchObject({ twoFactorRedirect: true });
  // The password step's session is withdrawn: its cookie is only cleared.
  const sessionCookies = headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  expect(sessionCookies.every((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(
    true,
  );
  return cookieHeader(headers, CHALLENGE_COOKIE);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('invalid base32 character in the otpauth secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 as an authenticator app computes it: HMAC-SHA1 over the
 * 30-second counter, dynamic truncation, six digits. */
function authenticatorCode(key: Buffer, offsetPeriods = 0): string {
  const counter =
    Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + offsetPeriods;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** The otpauth:// URI an authenticator enrolment returns. */
function totpUriOf(enabled: { method: string } | { totpURI: string }): string {
  return 'totpURI' in enabled ? enabled.totpURI : '';
}

/** The otpauth:// URI's secret, decoded to the key an authenticator uses. */
function keyFromUri(totpURI: string): Buffer {
  const uri = new URL(totpURI);
  expect(uri.protocol).toBe('otpauth:');
  return base32Decode(uri.searchParams.get('secret') ?? '');
}

/** A code from a different secret that no window of `key` accepts. */
async function unrelatedCode(auth: Auth, key: Buffer): Promise<string> {
  const accepted = new Set(
    [-1, 0, 1].map((offset) => authenticatorCode(key, offset)),
  );
  for (;;) {
    const { code } = await auth.api.generateTOTP({
      body: { secret: randomBytes(24).toString('base64url') },
    });
    if (!accepted.has(code)) {
      return code;
    }
  }
}

/** A six-digit code guaranteed to differ from `code` in every position. */
function neverIssued(code: string): string {
  return code.replaceAll(/\d/g, (digit) => String((Number(digit) + 1) % 10));
}

function codeFrom(message: MailMessage | undefined): string {
  const code = /\b(\d{6})\b/.exec(message?.text ?? '')?.[1];
  expect(code).toBeDefined();
  return code ?? '';
}

async function twoFactorEnabled(handle: Db, userId: string): Promise<boolean> {
  const [row] = await handle.sql<{ enabled: boolean }[]>`
    SELECT two_factor_enabled AS enabled FROM "user" WHERE id = ${userId}
  `;
  return row?.enabled ?? false;
}

type LockState = {
  readonly failedVerificationCount: number;
  readonly lockedUntilMs: number | null;
};

async function lockState(handle: Db, userId: string): Promise<LockState> {
  const [row] = await handle.sql<LockState[]>`
    SELECT failed_verification_count AS "failedVerificationCount",
           (extract(epoch FROM locked_until) * 1000)::float8 AS "lockedUntilMs"
    FROM two_factor WHERE user_id = ${userId}
  `;
  expect(row).toBeDefined();
  return row ?? { failedVerificationCount: -1, lockedUntilMs: null };
}

/** Enrols an authenticator app for the fixture user and returns its key. */
async function enrolAuthenticator(fixture: Fixture): Promise<Buffer> {
  const session = await signedInSession(fixture.auth);
  const enabled = await fixture.auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers: session,
  });
  const key = keyFromUri(totpUriOf(enabled));
  await fixture.auth.api.verifyTOTP({
    body: { code: authenticatorCode(key) },
    headers: session,
  });
  expect(await twoFactorEnabled(fixture.handle, fixture.userId)).toBe(true);
  return key;
}

describe('two-factor authentication', () => {
  it('enrols an authenticator app: its code verifies, a code from another secret does not (AUTH-08)', async () => {
    await withFixture(async (fixture) => {
      const { auth, handle, userId } = fixture;
      const session = await signedInSession(auth);
      expect(await twoFactorEnabled(handle, userId)).toBe(false);

      const enabled = await auth.api.enableTwoFactor({
        body: { password: PASSWORD },
        headers: session,
      });
      expect(enabled.method).toBe('totp');
      const key = keyFromUri(totpUriOf(enabled));
      expect(new URL(totpUriOf(enabled)).pathname).toContain('Plakboek');
      // Issued but not yet confirmed: still off.
      expect(await twoFactorEnabled(handle, userId)).toBe(false);

      await expect(
        auth.api.verifyTOTP({
          body: { code: await unrelatedCode(auth, key) },
          headers: session,
        }),
      ).rejects.toMatchObject({ body: { code: 'INVALID_CODE' } });
      expect(await twoFactorEnabled(handle, userId)).toBe(false);

      await auth.api.verifyTOTP({
        body: { code: authenticatorCode(key) },
        headers: session,
      });
      expect(await twoFactorEnabled(handle, userId)).toBe(true);

      // The next sign-in is challenged, and the plugin's own generator
      // produces the same code the authenticator does.
      const pending = await challenge(auth);
      const { code } = await auth.api.generateTOTP({
        body: { secret: key.toString('utf8') },
      });
      expect([-1, 0, 1].map((o) => authenticatorCode(key, o))).toContain(code);
      const verified = await auth.api.verifyTOTP({
        body: { code },
        headers: pending,
        returnHeaders: true,
      });
      const resolved = await auth.api.getSession({
        headers: cookieHeader(verified.headers, SESSION_COOKIE),
      });
      expect(resolved?.user.id).toBe(userId);
    });
  });

  it('enables an emailed code: exactly one message, and its code verifies (AUTH-07)', async () => {
    await withFixture(async (fixture) => {
      const { auth, handle, mail, userId } = fixture;
      const session = await signedInSession(auth);
      await auth.api.enableTwoFactor({
        body: { password: PASSWORD, method: 'otp' },
        headers: session,
      });
      expect(await twoFactorEnabled(handle, userId)).toBe(true);

      const pending = await challenge(auth);
      expect(mail.sent).toEqual([]);
      await auth.api.sendTwoFactorOTP({ body: {}, headers: pending });

      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(EMAIL);
      const code = codeFrom(mail.sent[0]);

      await expect(
        auth.api.verifyTwoFactorOTP({
          body: { code: neverIssued(code) },
          headers: pending,
        }),
      ).rejects.toMatchObject({ body: { code: 'INVALID_CODE' } });

      const verified = await auth.api.verifyTwoFactorOTP({
        body: { code },
        headers: pending,
        returnHeaders: true,
      });
      const resolved = await auth.api.getSession({
        headers: cookieHeader(verified.headers, SESSION_COOKIE),
      });
      expect(resolved?.user.id).toBe(userId);
      expect(mail.sent).toHaveLength(1);
    });
  });

  it('locks after five failures mixed across both factors and unlocks on its own (D-04)', async () => {
    await withFixture(async (fixture) => {
      const { auth, handle, mail, userId } = fixture;
      const key = await enrolAuthenticator(fixture);
      const pending = await challenge(auth);
      const wrongTotp = await unrelatedCode(auth, key);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(
          auth.api.verifyTOTP({ body: { code: wrongTotp }, headers: pending }),
        ).rejects.toMatchObject({ body: { code: 'INVALID_CODE' } });
      }
      expect(await lockState(handle, userId)).toEqual({
        failedVerificationCount: 4,
        lockedUntilMs: null,
      });

      await auth.api.sendTwoFactorOTP({ body: {}, headers: pending });
      const emailed = codeFrom(mail.sent.at(-1));
      const beforeLock = Date.now();
      await expect(
        auth.api.verifyTwoFactorOTP({
          body: { code: neverIssued(emailed) },
          headers: pending,
        }),
      ).rejects.toMatchObject({ body: { code: 'INVALID_CODE' } });
      const afterLock = Date.now();

      // The fifth failure came through the other factor and still locked.
      const locked = await lockState(handle, userId);
      expect(locked.failedVerificationCount).toBe(5);
      expect(locked.lockedUntilMs).toBeGreaterThanOrEqual(
        beforeLock + LOCK_DURATION_MS - TOLERANCE_MS,
      );
      expect(locked.lockedUntilMs).toBeLessThanOrEqual(
        afterLock + LOCK_DURATION_MS + TOLERANCE_MS,
      );

      // Correct codes on either factor are refused while locked.
      await expect(
        auth.api.verifyTOTP({
          body: { code: authenticatorCode(key) },
          headers: pending,
        }),
      ).rejects.toMatchObject({
        body: { code: 'ACCOUNT_TEMPORARILY_LOCKED' },
      });
      await expect(
        auth.api.verifyTwoFactorOTP({
          body: { code: emailed },
          headers: pending,
        }),
      ).rejects.toMatchObject({
        body: { code: 'ACCOUNT_TEMPORARILY_LOCKED' },
      });

      // Fifteen minutes pass; nobody unlocks anything.
      await handle.sql`
        UPDATE two_factor
        SET locked_until = locked_until - interval '15 minutes 1 second'
        WHERE user_id = ${userId}
      `;

      const verified = await auth.api.verifyTOTP({
        body: { code: authenticatorCode(key) },
        headers: pending,
        returnHeaders: true,
      });
      const resolved = await auth.api.getSession({
        headers: cookieHeader(verified.headers, SESSION_COOKIE),
      });
      expect(resolved?.user.id).toBe(userId);
      expect(await lockState(handle, userId)).toEqual({
        failedVerificationCount: 0,
        lockedUntilMs: null,
      });
    });
  });
});
