/**
 * The better-auth plugin that gives the login modal its two missing
 * password-link endpoints. better-auth's own reset routes stay closed (see
 * `DISABLED_AUTH_PATHS`), and `requestPasswordLink` / `completeSetPassword`
 * exist as library functions only; this plugin is the HTTP face of those two
 * functions, mounted under the same `/api/auth` base as every other route.
 *
 * - `POST /plakboek/password-link/request` -- forgot password. Issues a
 *   reset-password link through `requestPasswordLink` and answers one status
 *   and one body for every well-formed request, whether or not the address is
 *   registered. Set-password links are issued by invitations only, never by
 *   this endpoint.
 * - `POST /plakboek/password-link/complete` -- the set-password and
 *   reset-password landings. Spends the emailed token through
 *   `completeSetPassword`; every token failure (expired, used, unknown)
 *   answers one `INVALID_LINK`, and a too-short password answers
 *   `PASSWORD_TOO_SHORT` without spending the link.
 *
 * Both endpoints sit behind better-auth's limiter (three request steps and
 * ten complete steps per client per 60 seconds). That closes the accepted
 * risk the first auth phase recorded for unauthenticated reset requests.
 * The limiter is on in production and off elsewhere unless
 * `createAuth({ rateLimitEnabled: true })` switches it on.
 *
 * Both endpoints run better-auth's form-CSRF middleware, the one its own
 * sign-in uses, so a request from a foreign origin is refused the same way.
 *
 * Bodies are validated by hand: the checks are a handful of type and length
 * tests, and a schema library would be a new dependency for them.
 */
import {
  APIError,
  createAuthEndpoint,
  formCsrfMiddleware,
} from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import type { AuditFailureHook } from './audit.js';
import type { RenderAuthEmail } from './config.js';
import {
  completeSetPassword,
  requestPasswordLink,
  type PasswordLinkPurpose,
} from './credentials.js';
import type { MailSender } from './email/types.js';
import { PasswordPolicyError } from './password-policy.js';
import { InvalidOrExpiredTokenError, type TokenDatabase } from './tokens.js';

/** The plugin's id and the two paths it serves, relative to the auth base
 * path. */
export const PASSWORD_LINK_PLUGIN_ID = 'plakboek-password-links';
export const PASSWORD_LINK_REQUEST_PATH = '/plakboek/password-link/request';
export const PASSWORD_LINK_COMPLETE_PATH = '/plakboek/password-link/complete';

/** Rate-limit rules: steps allowed per client within `window` seconds. */
export const PASSWORD_LINK_RATE_LIMITS = Object.freeze({
  request: Object.freeze({ window: 60, max: 3 }),
  complete: Object.freeze({ window: 60, max: 10 }),
});

/** Longest values the endpoints read; anything longer is not a real value. */
const MAX_EMAIL_LENGTH = 320;
const MAX_NEXT_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 1024;

export type PasswordLinkPluginOptions = {
  readonly db: TokenDatabase;
  readonly mail: MailSender;
  readonly renderEmail: RenderAuthEmail;
  readonly baseURL: string;
  readonly onDeliveryError: (error: unknown) => void;
  readonly onAuditWriteFailed?: AuditFailureHook;
};

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? Reflect.get(body, key)
    : undefined;
}

function invalidRequest(): APIError {
  return APIError.from('BAD_REQUEST', {
    code: 'INVALID_REQUEST',
    message: 'The request is not valid',
  });
}

function invalidLink(): APIError {
  return APIError.from('BAD_REQUEST', {
    code: 'INVALID_LINK',
    message: 'This link is invalid or has expired',
  });
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength
    ? value
    : undefined;
}

/** The complete endpoint accepts exactly these two purposes. */
function linkPurpose(value: unknown): PasswordLinkPurpose | undefined {
  return value === 'set-password' || value === 'reset-password'
    ? value
    : undefined;
}

/**
 * Builds the `plakboek-password-links` plugin. `createAuth` installs it; it
 * is not part of the package's public surface.
 */
export function passwordLinkPlugin(options: PasswordLinkPluginOptions) {
  return {
    id: PASSWORD_LINK_PLUGIN_ID,
    endpoints: {
      requestPasswordLinkEndpoint: createAuthEndpoint(
        PASSWORD_LINK_REQUEST_PATH,
        { method: 'POST', use: [formCsrfMiddleware] },
        async (ctx) => {
          const body: unknown = ctx.body;
          const email = boundedString(field(body, 'email'), MAX_EMAIL_LENGTH);
          const next = field(body, 'next');
          const nextValue =
            next === undefined
              ? undefined
              : boundedString(next, MAX_NEXT_LENGTH);
          if (
            email === undefined ||
            (next !== undefined && nextValue === undefined)
          ) {
            throw invalidRequest();
          }
          await requestPasswordLink(
            {
              db: options.db,
              mail: options.mail,
              renderEmail: options.renderEmail,
              baseURL: options.baseURL,
              onDeliveryError: options.onDeliveryError,
            },
            { email, purpose: 'reset-password', next: nextValue },
          );
          return await ctx.json({ status: true });
        },
      ),
      completePasswordLinkEndpoint: createAuthEndpoint(
        PASSWORD_LINK_COMPLETE_PATH,
        { method: 'POST', use: [formCsrfMiddleware] },
        async (ctx) => {
          const body: unknown = ctx.body;
          const purpose = linkPurpose(field(body, 'purpose'));
          const newPassword = boundedString(
            field(body, 'newPassword'),
            MAX_PASSWORD_LENGTH,
          );
          if (purpose === undefined || newPassword === undefined) {
            throw invalidRequest();
          }
          const token = boundedString(field(body, 'token'), MAX_TOKEN_LENGTH);
          if (token === undefined) {
            throw invalidLink();
          }
          try {
            await completeSetPassword(
              {
                db: options.db,
                auth: { $context: Promise.resolve(ctx.context) },
                ...(options.onAuditWriteFailed === undefined
                  ? {}
                  : { onAuditWriteFailed: options.onAuditWriteFailed }),
              },
              { purpose, token, newPassword },
            );
          } catch (error) {
            if (error instanceof InvalidOrExpiredTokenError) {
              throw invalidLink();
            }
            if (error instanceof PasswordPolicyError) {
              throw APIError.from('BAD_REQUEST', {
                code: 'PASSWORD_TOO_SHORT',
                message: error.message,
              });
            }
            throw error;
          }
          return await ctx.json({ status: true });
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) =>
          path.startsWith(PASSWORD_LINK_REQUEST_PATH),
        ...PASSWORD_LINK_RATE_LIMITS.request,
      },
      {
        pathMatcher: (path: string) =>
          path.startsWith(PASSWORD_LINK_COMPLETE_PATH),
        ...PASSWORD_LINK_RATE_LIMITS.complete,
      },
    ],
  } satisfies BetterAuthPlugin;
}
