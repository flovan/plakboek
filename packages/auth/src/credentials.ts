/**
 * The credential-setting path the invite flow and the self-service reset
 * flow share (AUTH-05). Requesting a link reveals nothing about whether an
 * address is registered.
 *
 * The unknown-address branch is load-bearing. It does the same work as the
 * known-address branch instead of returning early: the same user lookup,
 * the same token issue against `verification` (for a random subject, rolled
 * back so nothing persists), and the same message render (discarded, never
 * sent). Replacing it with an early return reintroduces the enumeration side
 * channel the Phase 2 roadmap note exists to close, because the response
 * time would then show which addresses are registered. A generic message
 * with an early return is still that side channel.
 *
 * The mail send is dispatched, never awaited (D-15). An SMTP round trip is
 * slow enough to reveal the branch by timing, so its failure is reported
 * through `onDeliveryError` instead of reaching the caller.
 *
 * Neither the address, nor the link, nor the token is ever logged.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  SET_PASSWORD_TOKEN_TTL_SECONDS,
  type RenderAuthEmail,
} from './config.js';
import { renderAuthEmail } from './email/render.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from './email/types.js';
import { user } from './schema.js';
import { issueSingleUseToken, type TokenDatabase } from './tokens.js';

/** The two link purposes this module issues. Each is also the name of the
 * email template sent for it. */
export type PasswordLinkPurpose = 'set-password' | 'reset-password';

/**
 * What a link request returns. It has one shape only, with no variant for
 * an unknown address, so a caller cannot branch on something it must not
 * observe.
 */
export type PasswordLinkRequestOutcome = { readonly delivered: true };

/** Observation points for tests. Each fires once per request, on both the
 * known-address and the unknown-address branch. */
export type PasswordLinkProbe = {
  onTokenGenerated?(): void;
  onVerificationQuery?(): void;
};

export type RequestPasswordLinkDeps = {
  /** The database, or an enclosing transaction (issuing then nests as a
   * savepoint). */
  readonly db: TokenDatabase;
  readonly mail: MailSender;
  /** Defaults to `renderAuthEmail`. */
  readonly renderEmail?: RenderAuthEmail;
  /** The installation's absolute http(s) URL. Links are resolved against
   * its origin. */
  readonly baseURL: string;
  /**
   * Receives every failure to render or deliver a link message. The send is
   * detached from the request, so the requester never learns of a failure;
   * this hook is where the host does. Defaults to one `console.error` line
   * naming only the error type and, for a `MailSendError`, the recipient's
   * domain.
   */
  readonly onDeliveryError?: (error: unknown) => void;
  readonly probe?: PasswordLinkProbe;
};

export type RequestPasswordLinkInput = {
  readonly email: string;
  readonly purpose: PasswordLinkPurpose;
};

/** Where each link lands, under `/cms`, which the admin shell reserves. The
 * paths are absolute, so a base URL with or without a trailing slash yields
 * the same link. */
export const PASSWORD_LINK_PATHS: Readonly<
  Record<PasswordLinkPurpose, string>
> = Object.freeze({
  'set-password': '/cms/set-password',
  'reset-password': '/cms/reset-password',
});

/** The query parameter the link carries its token in. */
const LINK_TOKEN_PARAMETER = 'token';

const SECONDS_PER_HOUR = 60 * 60;

const PASSWORD_LINK_PURPOSES: readonly PasswordLinkPurpose[] = Object.freeze([
  'set-password',
  'reset-password',
]);

const OUTCOME: PasswordLinkRequestOutcome = Object.freeze({ delivered: true });

/** Returns the matching purpose constant. The purpose is chosen by this
 * library's own callers, not by a request, so a wrong one throws. */
function knownLinkPurpose(purpose: unknown): PasswordLinkPurpose {
  const known = PASSWORD_LINK_PURPOSES.find(
    (candidate) => candidate === purpose,
  );
  if (known === undefined) {
    throw new TypeError(
      `@plakboek/auth: a password link purpose must be one of ${PASSWORD_LINK_PURPOSES.join(', ')}`,
    );
  }
  return known;
}

/** The link without its token. Built before any database work, so a bad
 * base URL throws the same way for every address. */
function passwordLinkBase(baseURL: unknown, purpose: PasswordLinkPurpose): URL {
  const base =
    typeof baseURL === 'string' && URL.canParse(baseURL)
      ? new URL(baseURL)
      : null;
  if (
    base === null ||
    (base.protocol !== 'https:' && base.protocol !== 'http:')
  ) {
    throw new TypeError(
      '@plakboek/auth: baseURL must be an absolute http or https URL',
    );
  }
  return new URL(PASSWORD_LINK_PATHS[purpose], base);
}

function withToken(linkBase: URL, token: string): string {
  const link = new URL(linkBase);
  link.searchParams.set(LINK_TOKEN_PARAMETER, token);
  return link.toString();
}

/** The form an address is stored and looked up in. Anything that is not a
 * string becomes the empty string, which matches no user. */
function lookupForm(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** The fallback for `onDeliveryError`: one line, no address, no url, no
 * token -- only what failed and, when known, the recipient's domain. */
function defaultOnDeliveryError(error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error;
  const domain =
    error instanceof MailSendError
      ? ` (recipient domain ${error.recipientDomain})`
      : '';
  // oxlint-disable-next-line no-console -- the documented default fallback; a host routes delivery failures elsewhere through `onDeliveryError`
  console.error(`[@plakboek/auth] mail delivery failed: ${kind}${domain}`);
}

/** A hook that throws or rejects must not escape: the send it reports on
 * is already detached from the request that could handle the error. */
function reportDeliveryError(
  hook: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  if (hook === undefined) {
    defaultOnDeliveryError(error);
    return;
  }
  try {
    const returned: unknown = hook(error);
    if (returned instanceof Promise) {
      returned.catch(() => {
        defaultOnDeliveryError(error);
      });
    }
  } catch {
    defaultOnDeliveryError(error);
  }
}

/** Thrown inside the unknown-address transaction to roll it back. Caught
 * by `requestPasswordLink` itself; it never escapes. */
class RehearsalDiscarded extends Error {
  constructor() {
    super('@plakboek/auth: discarded the unknown-address rehearsal');
    this.name = 'RehearsalDiscarded';
  }
}

function assertRequestDeps(deps: RequestPasswordLinkDeps): void {
  if (
    typeof deps.mail !== 'object' ||
    deps.mail === null ||
    typeof deps.mail.send !== 'function'
  ) {
    throw new TypeError(
      '@plakboek/auth: mail must be a MailSender with a send function',
    );
  }
  if (
    deps.renderEmail !== undefined &&
    typeof deps.renderEmail !== 'function'
  ) {
    throw new TypeError(
      '@plakboek/auth: renderEmail must be a function returning a MailMessage',
    );
  }
}

/**
 * Issues a set-password or reset-password link for `input.email` and mails
 * it, if the address belongs to a user. Always resolves to the same
 * `{ delivered: true }`, whether or not it does, and never throws for an
 * unknown or malformed address.
 *
 * Both branches run the same steps in the same order:
 *
 * 1. Look the address up in `user`.
 * 2. In one transaction, issue a token through `issueSingleUseToken`: for
 *    the user, or for a random subject that matches no one. The user's
 *    transaction commits, and its issue removes every earlier outstanding
 *    link of that purpose (D-09). The other rolls back, so no row is left.
 * 3. Render the message for the purpose. The user's message is dispatched
 *    without being awaited; the other is discarded.
 *
 * The template follows `input.purpose` (`set-password` for an invite,
 * `reset-password` for a self-service reset), never whether the user
 * already has a credential. Throws `TypeError` for an unsupported purpose
 * or invalid dependencies, before any work.
 */
export async function requestPasswordLink(
  deps: RequestPasswordLinkDeps,
  input: RequestPasswordLinkInput,
): Promise<PasswordLinkRequestOutcome> {
  const purpose = knownLinkPurpose(input.purpose);
  assertRequestDeps(deps);
  const linkBase = passwordLinkBase(deps.baseURL, purpose);
  const renderEmail = deps.renderEmail ?? renderAuthEmail;
  const email = lookupForm(input.email);

  const [found] = await deps.db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  let token = '';
  try {
    await deps.db.transaction(async (tx) => {
      const issued = await issueSingleUseToken(tx, {
        subjectId: found?.id ?? randomUUID(),
        purpose,
        ttlSeconds: SET_PASSWORD_TOKEN_TTL_SECONDS,
      });
      token = issued.token;
      deps.probe?.onTokenGenerated?.();
      deps.probe?.onVerificationQuery?.();
      if (found === undefined) {
        // Roll the rehearsal back: nothing it wrote may persist.
        throw new RehearsalDiscarded();
      }
    });
  } catch (error) {
    if (!(error instanceof RehearsalDiscarded)) {
      throw error;
    }
  }

  let message: MailMessage;
  try {
    message = renderEmail(purpose, {
      to: found?.email ?? email,
      url: withToken(linkBase, token),
      expiresInHours: String(SET_PASSWORD_TOKEN_TTL_SECONDS / SECONDS_PER_HOUR),
      ...(found === undefined ? {} : { name: found.name }),
    });
  } catch (error) {
    if (found !== undefined) {
      reportDeliveryError(deps.onDeliveryError, error);
    }
    return OUTCOME;
  }

  if (found !== undefined) {
    try {
      void deps.mail.send(message).catch((error: unknown) => {
        reportDeliveryError(deps.onDeliveryError, error);
      });
    } catch (error) {
      reportDeliveryError(deps.onDeliveryError, error);
    }
  }
  return OUTCOME;
}
