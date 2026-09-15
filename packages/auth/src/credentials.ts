/**
 * The credential-setting path the invite flow and the self-service reset
 * flow share (AUTH-05). Requesting a link reveals nothing about whether an
 * address is registered.
 *
 * The unknown-address branch is load-bearing. It does the same work as the
 * known-address branch instead of returning early: the same user lookup,
 * the same token issue against `verification` (for a random subject, whose
 * row is deleted again before the commit so nothing persists), and the same
 * message render (discarded, never sent). Replacing it with an early return
 * reintroduces the enumeration side channel the Phase 2 roadmap note exists
 * to close, because the response time would then show which addresses are
 * registered. A generic message with an early return is still that side
 * channel.
 *
 * Both branches also end their database work the same way: the same
 * statements, then `COMMIT`. A rollback on only one branch would skip the
 * WAL flush a commit waits for, which is a timing difference of its own.
 * What remains is that the unknown branch's discard deletes one row where
 * the known branch's deletes none.
 *
 * The mail send is dispatched, never awaited (D-15). An SMTP round trip is
 * slow enough to reveal the branch by timing, so its failure is reported
 * through `onDeliveryError` instead of reaching the caller.
 *
 * Neither the address, nor the link, nor the token is ever logged.
 *
 * Completing a link checks the new password against the policy before the
 * link is spent, so a too-short attempt leaves the user's only valid link
 * usable. The credential write, the revocation of the user's sessions and
 * the audit row then all run inside the transaction that consumes the link:
 * they commit together, or the link survives (AUTH-11).
 */
import { randomUUID } from 'node:crypto';
import type { Permission, PermissionResolver } from '@plakboek/permissions';
import { and, eq, like, or } from 'drizzle-orm';
import { createAuditRecorder, type AuditFailureHook } from './audit.js';
import {
  SET_PASSWORD_TOKEN_TTL_SECONDS,
  type Auth,
  type RenderAuthEmail,
} from './config.js';
import { renderAuthEmail } from './email/render.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from './email/types.js';
import { assertPasswordPolicy } from './password-policy.js';
import { account, session, user, verification } from './schema.js';
import {
  InvalidOrExpiredTokenError,
  consumeSingleUseToken,
  issueSingleUseToken,
  type TokenDatabase,
  type TokenTransaction,
} from './tokens.js';

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
 *    issue removes every earlier outstanding link of that purpose (D-09).
 *    Then discard every link of one subject: the rehearsal's own subject,
 *    so no row is left, or for the user a fresh random subject that has
 *    none. Both transactions commit.
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
  await deps.db.transaction(async (tx) => {
    const rehearsalSubjectId = randomUUID();
    const issued = await issueSingleUseToken(tx, {
      subjectId: found?.id ?? rehearsalSubjectId,
      purpose,
      ttlSeconds: SET_PASSWORD_TOKEN_TTL_SECONDS,
    });
    token = issued.token;
    deps.probe?.onTokenGenerated?.();
    deps.probe?.onVerificationQuery?.();
    // The same statement on both branches. For an unknown address it
    // removes the rehearsal's row, so nothing it wrote persists; for a user
    // it names a subject no link was issued to and removes nothing.
    await tx
      .delete(verification)
      .where(
        and(
          eq(
            verification.value,
            found === undefined ? rehearsalSubjectId : randomUUID(),
          ),
          like(verification.identifier, `${purpose}:%`),
        ),
      );
  });

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

export type CompleteSetPasswordDeps = {
  /** The database, or an enclosing transaction (the consumption then nests
   * as a savepoint). */
  readonly db: TokenDatabase;
  /** Supplies better-auth's own password hasher and the installation's
   * configured minimum password length. No better-auth endpoint is
   * called. */
  readonly auth: Pick<Auth, '$context'>;
  /** Passed to the audit recorder. */
  readonly onAuditWriteFailed?: AuditFailureHook;
  readonly now?: () => Date;
};

export type CompleteSetPasswordInput = {
  readonly purpose: PasswordLinkPurpose;
  readonly token: string;
  readonly newPassword: string;
};

/** The `audit_log.action` recorded when a link sets a user's password. */
export const CREDENTIAL_SET_ACTION = 'credential.set';

/** The permission the audit row names for a credential set through a link.
 * The link holder is granted it for that one row; see `linkHolderResolver`. */
const CREDENTIAL_SET_PERMISSION: Permission = 'users:reset-password';

/** better-auth's provider id for email-and-password credentials. */
const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * Thrown when the credential could not be written. The transaction rolled
 * back, so the link is still valid. The message names the error types and
 * SQLSTATE codes along the cause chain and nothing else: a failed query's
 * own message quotes its parameters, and here one of them is the new
 * password's hash, so that error is deliberately not kept as `cause`.
 */
export class CredentialWriteError extends Error {
  readonly code: string | undefined;

  constructor(failure: unknown) {
    const chain = describeFailure(failure);
    super(
      `@plakboek/auth: could not write the credential; the link is still valid (${chain.description})`,
    );
    this.name = 'CredentialWriteError';
    this.code = chain.code;
  }
}

const MAX_FAILURE_DEPTH = 3;

function describeFailure(failure: unknown): {
  readonly description: string;
  readonly code: string | undefined;
} {
  const parts: string[] = [];
  let code: string | undefined;
  let current = failure;
  for (let depth = 0; depth < MAX_FAILURE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const currentCode: unknown = Reflect.get(current, 'code');
    if (typeof currentCode === 'string') {
      code ??= currentCode;
      parts.push(`${current.name} ${currentCode}`);
    } else {
      parts.push(current.name);
    }
    current = current.cause;
  }
  return {
    description: parts.length > 0 ? parts.join(' <- ') : 'unknown error',
    code,
  };
}

/**
 * The permission decision for a credential set through a link. The link is
 * the authorisation: `consumeSingleUseToken` has already proven, in this
 * transaction, that its holder was sent it for `subjectId`. So the recorder
 * is handed a resolver that grants exactly the credential-set permission,
 * to exactly that user, and nothing else. The user's own role is not
 * consulted, because an editor resetting their own password holds no user
 * management permission.
 */
function linkHolderResolver(subjectId: string): PermissionResolver {
  const granted: ReadonlySet<Permission> = new Set([CREDENTIAL_SET_PERMISSION]);
  const nothing: ReadonlySet<Permission> = new Set();
  return {
    resolve: (_roleKey, context) =>
      context?.userId === subjectId ? granted : nothing,
    isKnownRole: () => true,
  };
}

/** Sets the user's email-and-password credential: updates the existing
 * credential account, or creates one when the user has none yet. */
async function writeCredential(
  tx: TokenTransaction,
  userId: string,
  passwordHash: string,
  at: Date,
): Promise<void> {
  try {
    const updated = await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: at })
      .where(
        and(
          eq(account.userId, userId),
          eq(account.providerId, CREDENTIAL_PROVIDER_ID),
        ),
      )
      .returning({ id: account.id });
    if (updated.length === 0) {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId,
        password: passwordHash,
        createdAt: at,
        updatedAt: at,
      });
    }
  } catch (error) {
    throw new CredentialWriteError(error);
  }
}

/**
 * Sets a user's password through a set-password or reset-password link and
 * returns the id of the user whose credential changed.
 *
 * 1. The password is checked against the minimum `createAuth` configured.
 *    A too-short password throws `PasswordPolicyError` and spends nothing,
 *    so a typo does not cost the user their only valid link (D-08, D-09).
 * 2. The password is hashed with better-auth's own hasher, outside any
 *    transaction.
 * 3. The link is consumed, and in that same transaction:
 *    - the user row is locked, so credential writes for one user serialise;
 *    - the credential account is updated, or created when there is none;
 *    - every session of the user is deleted, and every session in which the
 *      user is impersonating someone, so a session stolen before a reset
 *      does not survive it;
 *    - every other outstanding set-password or reset-password link for the
 *      user is deleted;
 *    - one `credential.set` audit row is written, naming the user as actor
 *      and entity.
 *
 * A failure anywhere rolls all of it back, the link included. A bad, spent
 * or expired link throws `InvalidOrExpiredTokenError`, as does a link whose
 * user no longer exists. A failed credential write throws
 * `CredentialWriteError`.
 *
 * better-auth's own reset endpoint consumes the token and writes the
 * password in two separate adapter calls, and its routes are closed. Never
 * call it, even server-side.
 */
export async function completeSetPassword(
  deps: CompleteSetPasswordDeps,
  input: CompleteSetPasswordInput,
): Promise<{ readonly userId: string }> {
  const purpose = knownLinkPurpose(input.purpose);
  const context = await deps.auth.$context;
  assertPasswordPolicy(
    input.newPassword,
    context.password.config.minPasswordLength,
  );

  const passwordHash = await context.password.hash(input.newPassword);
  const now = deps.now ?? (() => new Date());

  return await consumeSingleUseToken(
    deps.db,
    { purpose, token: input.token },
    async (tx, userId) => {
      const [subject] = await tx
        .select({ id: user.id, roleKey: user.role })
        .from(user)
        .where(eq(user.id, userId))
        .for('update');
      if (subject === undefined) {
        throw new InvalidOrExpiredTokenError(purpose);
      }

      const recorder = createAuditRecorder({
        db: tx,
        resolver: linkHolderResolver(userId),
        now,
        ...(deps.onAuditWriteFailed === undefined
          ? {}
          : { onAuditWriteFailed: deps.onAuditWriteFailed }),
      });

      return await recorder.run(
        { userId, roleKey: subject.roleKey ?? '' },
        {
          permission: CREDENTIAL_SET_PERMISSION,
          action: CREDENTIAL_SET_ACTION,
          entityType: 'user',
          entityId: userId,
        },
        async (audited) => {
          await writeCredential(audited, userId, passwordHash, now());
          const revoked = await audited
            .delete(session)
            .where(
              or(
                eq(session.userId, userId),
                eq(session.impersonatedBy, userId),
              ),
            )
            .returning({ id: session.id });
          await audited
            .delete(verification)
            .where(
              and(
                eq(verification.value, userId),
                or(
                  ...PASSWORD_LINK_PURPOSES.map((linkPurpose) =>
                    like(verification.identifier, `${linkPurpose}:%`),
                  ),
                ),
              ),
            );
          return {
            result: { userId },
            after: { purpose, revokedSessionCount: revoked.length },
          };
        },
      );
    },
    { now },
  );
}
