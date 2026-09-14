/**
 * `createAuth` -- the one place better-auth is configured for a Plakboek
 * installation. The host passes every dependency in (database handle, base
 * URL, secret, mail sender, role map); nothing here reads `process.env`.
 *
 * Every session, password, two-factor and magic-link policy from the phase
 * decisions is expressed here as a better-auth option, and each policy
 * number is exported once so tests, email copy and later modules read the
 * same value instead of restating it.
 */
import type { DefinedRoles } from '@plakboek/permissions';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, magicLink, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { renderAuthEmail, type AuthEmailKind } from './email/render.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from './email/types.js';
import { SUPERADMIN_ROLE_KEY } from './first-user.js';
import {
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
} from './password-policy.js';
import * as schema from './schema.js';

/** Renders one authentication email. `renderAuthEmail` is the default; a
 * host supplies its own to theme the copy without touching this module. */
export type RenderAuthEmail = (
  kind: AuthEmailKind,
  data: Record<string, string>,
) => MailMessage;

export type CreateAuthOptions = {
  readonly db: PostgresJsDatabase;
  readonly baseURL: string;
  readonly secret: string;
  readonly mail: MailSender;
  readonly roles: DefinedRoles;
  readonly appName?: string;
  readonly minPasswordLength?: number;
  /** Defaults to `renderAuthEmail`. */
  readonly renderEmail?: RenderAuthEmail;
  /**
   * Receives every failure to deliver a password-reset or magic-link
   * message. Those sends are detached from the request (D-15), so the
   * requester never learns of the failure; this hook is where the host
   * does. Defaults to one `console.error` line naming only the error type
   * and, for a `MailSendError`, the recipient's domain.
   */
  readonly onMailDeliveryError?: (error: unknown) => void;
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

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

/** D-01: a session lives 30 days from its last refresh. There is one
 * session credential and no separate refresh token. */
export const SESSION_EXPIRES_IN_SECONDS = 30 * SECONDS_PER_DAY;

/** D-01: a session used after this age slides its expiry forward, so the
 * refresh happens at most once a day rather than on every request. */
export const SESSION_UPDATE_AGE_SECONDS = SECONDS_PER_DAY;

/** AUTH-03: set-password and reset-password links are valid for 48 hours. */
export const SET_PASSWORD_TOKEN_TTL_SECONDS = 48 * SECONDS_PER_HOUR;

/** D-10: a magic link is a live login bypass, so it dies after 15 minutes. */
export const MAGIC_LINK_TTL_SECONDS = 15 * SECONDS_PER_MINUTE;

/** An emailed second-factor code is valid for five minutes: long enough to
 * survive a slow mail relay, short enough to be useless once read later. */
export const TWO_FACTOR_CODE_TTL_SECONDS = 5 * SECONDS_PER_MINUTE;

/** D-04: five failed second-factor attempts, counted across the
 * authenticator and emailed-code paths together, lock the account for
 * fifteen minutes. The lock clears on its own. */
export const TWO_FACTOR_LOCKOUT = Object.freeze({
  maxFailedAttempts: 5,
  durationSeconds: 15 * SECONDS_PER_MINUTE,
});

const DEFAULT_APP_NAME = 'Plakboek';

/**
 * The admin plugin's own access-control vocabulary, used as nothing more
 * than the coarse gate on the plugin's endpoints. Every real authorization
 * decision runs through `@plakboek/permissions`; no catalogue permission is
 * ever written here.
 *
 * The plugin's user-management endpoints (create, set role, ban, set
 * password, remove) would bypass the audit log, so no role is granted them:
 * user management goes through this package's own audited functions. The
 * superadmin may reach the impersonation endpoint, which this package wraps
 * with its own audited start and stop.
 */
const adminAccessControl = createAccessControl(defaultStatements);
const ADMIN_PLUGIN_ROLES = {
  [SUPERADMIN_ROLE_KEY]: adminAccessControl.newRole({
    user: ['impersonate'],
    session: [],
  }),
};

/**
 * Roles the admin plugin refuses as impersonation targets unless the actor
 * holds its `impersonate-admins` statement, which no role does. In the
 * installed release this list has no other effect: it does not gate who
 * reaches the plugin's endpoints. Listing only the superadmin makes the
 * plugin itself refuse a superadmin target (D-13), behind this package's
 * own pre-check.
 */
const IMPERSONATION_PROTECTED_ROLES = [SUPERADMIN_ROLE_KEY];

/** Endpoints whose `password` field sets a credential rather than checking
 * one. Every endpoint that carries `newPassword` sets one as well. */
const PASSWORD_SETTING_PATHS: ReadonlySet<string> = new Set([
  '/sign-up/email',
  '/admin/create-user',
]);

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function readField(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null
    ? Reflect.get(source, key)
    : undefined;
}

/** The password a better-auth request is about to store, if it stores one. */
function passwordBeingSet(path: string, body: unknown): unknown {
  const newPassword = readField(body, 'newPassword');
  if (newPassword !== undefined) {
    return newPassword;
  }
  return PASSWORD_SETTING_PATHS.has(path)
    ? readField(body, 'password')
    : undefined;
}

/**
 * Runs `assertPasswordPolicy` in front of every better-auth endpoint that
 * stores a password. better-auth's own `minPasswordLength` check counts
 * UTF-16 code units, so six emoji would pass it; the policy counts code
 * points, and this hook makes the two agree.
 */
const enforcePasswordPolicy = createAuthMiddleware(async (ctx) => {
  const candidate = passwordBeingSet(ctx.path, ctx.body);
  if (candidate === undefined) {
    return;
  }
  try {
    assertPasswordPolicy(typeof candidate === 'string' ? candidate : '');
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw APIError.from('BAD_REQUEST', {
        code: 'PASSWORD_TOO_SHORT',
        message: error.message,
      });
    }
    throw error;
  }
});

/** The fallback for `onMailDeliveryError`: one line, no address, no url,
 * no token -- only what failed and, when known, the recipient's domain. */
function defaultOnMailDeliveryError(error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error;
  const domain =
    error instanceof MailSendError
      ? ` (recipient domain ${error.recipientDomain})`
      : '';
  // oxlint-disable-next-line no-console -- the documented default fallback; a host routes delivery failures elsewhere through `onMailDeliveryError`
  console.error(`[@plakboek/auth] mail delivery failed: ${kind}${domain}`);
}

/**
 * Validates `createAuth`'s options before anything is constructed. Each
 * check names the option and what it must be; no message ever interpolates
 * a supplied value, so the secret can never reach a log through here.
 */
function assertCreateAuthOptions(options: CreateAuthOptions): void {
  const {
    baseURL,
    secret,
    mail,
    roles,
    minPasswordLength,
    renderEmail,
    onMailDeliveryError,
  } = options;

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

  if (renderEmail !== undefined && typeof renderEmail !== 'function') {
    throw new AuthConfigError(
      'renderEmail must be a function returning a MailMessage',
    );
  }

  if (
    onMailDeliveryError !== undefined &&
    typeof onMailDeliveryError !== 'function'
  ) {
    throw new AuthConfigError(
      'onMailDeliveryError must be a function when supplied',
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

  const renderEmail = options.renderEmail ?? renderAuthEmail;
  const onMailDeliveryError =
    options.onMailDeliveryError ?? defaultOnMailDeliveryError;

  /** A throwing hook must not escape: the send it reports on is already
   * detached from any request that could handle the error. */
  function reportMailDeliveryError(error: unknown): void {
    try {
      onMailDeliveryError(error);
    } catch {
      defaultOnMailDeliveryError(error);
    }
  }

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
      resetPasswordTokenExpiresIn: SET_PASSWORD_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // D-15: the send is dispatched, never awaited. better-auth only calls
      // this for a registered address, so awaiting an SMTP round trip here
      // would let response time reveal which addresses are registered.
      sendResetPassword: async ({ user, url }) => {
        try {
          const message = renderEmail('reset-password', {
            to: user.email,
            name: user.name,
            url,
            expiresInHours: String(
              SET_PASSWORD_TOKEN_TTL_SECONDS / SECONDS_PER_HOUR,
            ),
          });
          void options.mail.send(message).catch(reportMailDeliveryError);
        } catch (error) {
          reportMailDeliveryError(error);
        }
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    hooks: {
      before: enforcePasswordPolicy,
    },
    plugins: [
      admin({
        adminRoles: IMPERSONATION_PROTECTED_ROLES,
        roles: ADMIN_PLUGIN_ROLES,
        // D-12: an impersonation session ends through the explicit stop
        // action. The plugin has no "never expires" setting, so it lives as
        // long as an ordinary session and never times out before one does.
        impersonationSessionDuration: SESSION_EXPIRES_IN_SECONDS,
      }),
      twoFactor({
        issuer: options.appName ?? DEFAULT_APP_NAME,
        totpOptions: {},
        otpOptions: {
          period: TWO_FACTOR_CODE_TTL_SECONDS / SECONDS_PER_MINUTE,
          // Runs only after the password step succeeded, so there is no
          // enumeration surface and the send is awaited. The plugin
          // swallows a rejection here, so it is reported, not rethrown.
          sendOTP: async ({ user, otp }) => {
            try {
              await options.mail.send(
                renderEmail('two-factor-code', {
                  to: user.email,
                  code: otp,
                  expiresInMinutes: String(
                    TWO_FACTOR_CODE_TTL_SECONDS / SECONDS_PER_MINUTE,
                  ),
                }),
              );
            } catch (error) {
              reportMailDeliveryError(error);
            }
          },
        },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: TWO_FACTOR_LOCKOUT.maxFailedAttempts,
          durationSeconds: TWO_FACTOR_LOCKOUT.durationSeconds,
        },
      }),
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // Users are invited, never self-registered: a link for an unknown
        // address must not create an account when followed.
        disableSignUp: true,
        // D-15: the lookup runs on both paths; only a registered address
        // gets a message, and that send is dispatched, never awaited.
        sendMagicLink: async ({ email, url }, ctx) => {
          const found =
            await ctx?.context.internalAdapter.findUserByEmail(email);
          if (found === null || found === undefined) {
            return;
          }
          try {
            const message = renderEmail('magic-link', {
              to: found.user.email,
              url,
              expiresInMinutes: String(
                MAGIC_LINK_TTL_SECONDS / SECONDS_PER_MINUTE,
              ),
            });
            void options.mail.send(message).catch(reportMailDeliveryError);
          } catch (error) {
            reportMailDeliveryError(error);
          }
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
