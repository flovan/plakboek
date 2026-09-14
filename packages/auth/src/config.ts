/**
 * `createAuth` -- the one place better-auth is configured for a Plakboek
 * installation. The host passes every dependency in (database handle, base
 * URL, secret, mail sender, role map); nothing here reads `process.env`.
 */
import type { DefinedRoles } from '@plakboek/permissions';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { MailSender } from './email/types.js';
import { PASSWORD_MIN_LENGTH } from './password-policy.js';
import * as schema from './schema.js';

export type CreateAuthOptions = {
  readonly db: PostgresJsDatabase;
  readonly baseURL: string;
  readonly secret: string;
  readonly mail: MailSender;
  readonly roles: DefinedRoles;
  readonly appName?: string;
  readonly minPasswordLength?: number;
};

/** Thrown by `createAuth` for invalid options. Messages name the offending
 * option and the expected shape, never the supplied value (T-02-07). */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(`@plakboek/auth: ${message}`);
    this.name = 'AuthConfigError';
  }
}

/** better-auth signs session cookies with this secret; anything shorter is
 * brute-forceable enough to make a forged session cookie realistic. */
const MIN_SECRET_LENGTH = 32;

/** D-01: sessions last 30 days and slide forward once per day of activity. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

const DEFAULT_APP_NAME = 'Plakboek';

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates `createAuth`'s options before anything is constructed. Each
 * check names the option and what it must be; no message ever interpolates
 * a supplied value, so the secret can never reach a log through here.
 */
function assertCreateAuthOptions(options: CreateAuthOptions): void {
  const { baseURL, secret, mail, roles, minPasswordLength } = options;

  if (
    typeof baseURL !== 'string' ||
    baseURL.length === 0 ||
    !isParseableUrl(baseURL)
  ) {
    throw new AuthConfigError(
      'baseURL must be a non-empty, absolute URL such as "https://cms.example.com"',
    );
  }

  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(
      `secret must be a string of at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  if (
    typeof mail !== 'object' ||
    mail === null ||
    typeof mail.send !== 'function'
  ) {
    throw new AuthConfigError('mail must be a MailSender with a send function');
  }

  if (
    typeof roles !== 'object' ||
    roles === null ||
    Array.isArray(roles) ||
    Object.keys(roles).length === 0
  ) {
    throw new AuthConfigError(
      'roles must be a non-empty role map returned by defineRoles',
    );
  }

  if (
    minPasswordLength !== undefined &&
    (!Number.isInteger(minPasswordLength) ||
      minPasswordLength < PASSWORD_MIN_LENGTH)
  ) {
    throw new AuthConfigError(
      `minPasswordLength must be an integer of at least ${PASSWORD_MIN_LENGTH}`,
    );
  }
}

/**
 * Builds the better-auth instance for one installation. The drizzle adapter
 * has transactions switched on -- not its default -- so multi-step adapter
 * operations share one Postgres transaction; single-use token consumption
 * (AUTH-11) depends on it.
 */
export function createAuth(options: CreateAuthOptions) {
  assertCreateAuthOptions(options);

  return betterAuth({
    appName: options.appName ?? DEFAULT_APP_NAME,
    baseURL: options.baseURL,
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: options.minPasswordLength ?? PASSWORD_MIN_LENGTH,
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
