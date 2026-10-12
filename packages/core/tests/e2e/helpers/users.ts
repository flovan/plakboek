/**
 * Accounts the specs create for themselves, so a test that locks an account
 * or turns on two-step sign-in leaves the shared ones alone. They go through
 * the same engine the global setup used, against the same throwaway database:
 * the worker inherits the environment global setup exported.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createUserWithRole } from '@plakboek/auth';
import type { APIRequestContext } from '@playwright/test';
import { closeAllDbs } from '../../../src/runtime/db.ts';
import { readRuntimeEnv } from '../../../src/runtime/env.ts';
import { createRuntime } from '../../../src/runtime/runtime.ts';
import type { E2eAccount } from './host.ts';
import { secretOfOtpauthUri, totp } from './totp.ts';

export type TestUser = E2eAccount & { readonly name: string };

/**
 * Creates a user with a random address and a known password, in the role
 * `roleKey` (the e2e host defines `editor`, `viewer`, `superadmin`).
 */
export async function createTestUser(input: {
  readonly roleKey: string;
}): Promise<TestUser> {
  const { default: config } = await import('../../e2e-host/plakboek.config.ts');
  const runtime = createRuntime({ config }, readRuntimeEnv(process.env));
  try {
    const user: TestUser = {
      name: 'Test User',
      email: `e2e-${randomBytes(6).toString('hex')}@example.com`,
      password: `a passphrase ${randomUUID()}`,
    };
    const context = await runtime.auth.$context;
    await createUserWithRole(runtime.db.db, {
      id: randomUUID(),
      email: user.email,
      name: user.name,
      roleKey: input.roleKey,
      passwordHash: await context.password.hash(user.password),
    });
    return user;
  } finally {
    await closeAllDbs();
  }
}

/** What turning on two-step sign-in leaves the account with. */
export type Enrolment = {
  /** The base32 secret an authenticator app would hold. */
  readonly secret: string;
  /** The one-time backup codes issued with it. */
  readonly backupCodes: readonly string[];
};

/**
 * Turns two-step sign-in on for an account through the real auth API, as the
 * set-up step does: sign in, ask for the key with the password, and prove it
 * with a code. `request` should be a context of its own, whose cookies the
 * calls share; `origin` is the site's origin, which the auth endpoints check.
 */
export async function enrolTwoFactor(
  request: APIRequestContext,
  origin: string,
  account: E2eAccount,
): Promise<Enrolment> {
  const headers = { Origin: origin };
  const post = async (path: string, data: Record<string, unknown>) => {
    const response = await request.post(`${origin}/api/auth/${path}`, {
      data,
      headers,
    });
    if (response.status() !== 200) {
      throw new Error(`POST ${path} answered ${response.status()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };
  await post('sign-in/email', {
    email: account.email,
    password: account.password,
  });
  const enabled = await post('two-factor/enable', {
    password: account.password,
  });
  if (typeof enabled.totpURI !== 'string') {
    throw new Error('two-factor/enable returned no key');
  }
  const secret = secretOfOtpauthUri(enabled.totpURI);
  await post('two-factor/verify-totp', { code: totp(secret) });
  const backupCodes = Array.isArray(enabled.backupCodes)
    ? enabled.backupCodes.filter(
        (code): code is string => typeof code === 'string',
      )
    : [];
  return { secret, backupCodes };
}
