/**
 * Inviting a user and resending their password link (AUTH-02, AUTH-04,
 * D-09). better-auth has no invite workflow, so this module only composes
 * primitives that already hold their own guarantees:
 *
 * - `createUserWithRole` applies the first-user rule (D-14). An invite on an
 *   empty installation creates the superadmin, whatever role was asked for.
 * - `requestPasswordLink` looks the user up, issues the link through
 *   `issueSingleUseToken` and renders the message. That is the same path the
 *   self-service request uses, including its unknown-address rehearsal.
 * - `AuditRecorder.run` checks the permission, and writes the audit row in
 *   the transaction that creates the user and issues the link.
 *
 * The message is sent after that transaction has committed. A slow or
 * failing mail provider therefore never rolls a user back, and never
 * delivers a link to a row that no longer exists. The worst case is a
 * committed user whose link did not go out: `InviteDeliveryError` reports
 * it with the user's id, and a resend fixes it. Pass a recorder bound to the
 * database, not to an enclosing transaction; otherwise "committed" means
 * only that the savepoint was released.
 *
 * Both entry points are privileged, so, unlike the self-service request,
 * they await the send: the person inviting has to learn that a message did
 * not go out. Their errors still name the recipient's domain and opaque ids
 * only, never an address, a display name, a link or a token.
 */
import { randomUUID } from 'node:crypto';
import type { Permission } from '@plakboek/permissions';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AuditActor, AuditRecorder, AuditTransaction } from './audit.js';
import type { RenderAuthEmail } from './config.js';
import {
  requestPasswordLink,
  type PasswordLinkPurpose,
  type PasswordLinkRequestOutcome,
} from './credentials.js';
import {
  MailSendError,
  type MailMessage,
  type MailSender,
} from './email/types.js';
import { createUserWithRole, storedEmailForm } from './first-user.js';
import { account, user } from './schema.js';

export type InviteDeps = {
  /** Checks the permission and writes the audit row. Bind it to the
   * database itself (see the module comment). */
  readonly recorder: AuditRecorder;
  readonly mail: MailSender;
  /** Defaults to `renderAuthEmail`. */
  readonly renderEmail?: RenderAuthEmail;
  /** The installation's absolute http(s) URL. */
  readonly baseURL: string;
};

export type InviteUserInput = {
  /** Stored and looked up trimmed and lower-cased. */
  readonly email: string;
  readonly name: string;
  readonly roleKey: string;
  readonly actor: AuditActor;
  /**
   * The new user's id. Defaults to a random UUID. Supply it when the actor
   * is the invitee: on an empty installation no other user exists to act,
   * and the audit row's actor must be a user row by the time it is written.
   * Ignored when the address already belongs to a user.
   */
  readonly id?: string;
};

export type InviteUserResult = {
  readonly userId: string;
  readonly wasFirstUser: boolean;
};

export type ResendSetPasswordLinkInput = {
  readonly email: string;
  readonly actor: AuditActor;
};

/** The `audit_log.action` of an invite. */
export const USER_INVITE_ACTION = 'user.invite';

/** The `audit_log.action` of a resend. */
export const USER_RESEND_SET_PASSWORD_ACTION = 'user.resend-set-password';

const INVITE_PERMISSION: Permission = 'users:create';
/** The catalogue describes `users:create` as adding users and sending or
 * resending their set-password emails, so a resend needs it too, and
 * `users:reset-password` alone is not enough. */
const RESEND_PERMISSION: Permission = 'users:create';

/** better-auth's provider id for email-and-password credentials. */
const CREDENTIAL_PROVIDER_ID = 'credential';

/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

export type InviteField = 'email' | 'name' | 'roleKey' | 'id';

const FIELD_REQUIREMENTS: Readonly<Record<InviteField, string>> = Object.freeze(
  {
    email: 'a single email address with a local part and a domain',
    name: 'a non-empty display name',
    roleKey: 'a non-empty role key',
    id: 'a non-empty user id when one is supplied',
  },
);

/**
 * Thrown before any work when an invite's input is malformed. Names the
 * field and what it must be, never the supplied value.
 */
export class InvalidInviteError extends Error {
  readonly field: InviteField;

  constructor(field: InviteField) {
    super(`@plakboek/auth: an invite needs ${FIELD_REQUIREMENTS[field]}`);
    this.name = 'InvalidInviteError';
    this.field = field;
  }
}

/**
 * Thrown when the link was issued and committed but its message could not
 * be delivered. The user and the link stay in place, so the caller can offer
 * a resend to `userId`.
 *
 * `cause` is the sender's `MailSendError`. A sender that rejects with
 * anything else is outside the `MailSender` contract, and its error is
 * replaced by a `MailSendError` for the recipient, because its message may
 * quote the address. When the message could not be rendered, `cause` is the
 * renderer's error; `renderAuthEmail`'s errors name the template and field
 * only.
 */
export class InviteDeliveryError extends Error {
  readonly userId: string;
  readonly recipientDomain: string;

  constructor(userId: string, recipientDomain: string, cause?: unknown) {
    super(
      `@plakboek/auth: the password link for a user at ${recipientDomain} was issued but not delivered; resend it`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'InviteDeliveryError';
    this.userId = userId;
    this.recipientDomain = recipientDomain;
  }
}

/**
 * Thrown when a database statement of an invite or resend failed. The
 * transaction rolled back, so no user, link or audit row was committed. The
 * message names the error types and SQLSTATE codes along the cause chain and
 * nothing else: a failed query's own message quotes its parameters, which
 * here include the address and the display name, so that error is
 * deliberately not kept as `cause`.
 */
export class InviteWriteError extends Error {
  readonly code: string | undefined;

  constructor(failure: unknown) {
    const chain = describeFailure(failure);
    super(
      `@plakboek/auth: could not store the invite or its link; nothing was committed (${chain.description})`,
    );
    this.name = 'InviteWriteError';
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

/** The first SQLSTATE code along the cause chain, if any. */
function sqlStateOf(failure: unknown): string | undefined {
  return describeFailure(failure).code;
}

/** Control characters (CR and LF among them) have no place in an address
 * that ends up in a message header. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** The stored form of an invited address (`storedEmailForm`, the rule
 * `createUserWithRole` stores with), checked against the sender's shape
 * rule: exactly one `@`, with a non-blank part on either side. The lookup
 * that decides whether the address already has a user runs before the
 * creation, so it needs the stored form too. */
function inviteAddress(email: unknown): string {
  const address = storedEmailForm(email);
  const parts = address.split('@');
  const [local = '', domain = ''] = parts;
  if (
    parts.length !== 2 ||
    local.trim().length === 0 ||
    domain.trim().length === 0 ||
    hasControlCharacter(address)
  ) {
    throw new InvalidInviteError('email');
  }
  return address;
}

function requiredText(value: unknown, field: InviteField): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidInviteError(field);
  }
  return value;
}

/** The part after the last `@`, or `'unknown'`. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at === -1 ? '' : address.slice(at + 1).trim();
  return domain.length > 0 ? domain : 'unknown';
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
}

/** Checked before any work, so a misconfigured caller never creates a user
 * whose link cannot be built or sent. */
function assertInviteDeps(deps: InviteDeps): void {
  if (
    typeof deps.recorder !== 'object' ||
    deps.recorder === null ||
    typeof deps.recorder.run !== 'function'
  ) {
    throw new TypeError('@plakboek/auth: recorder must be an AuditRecorder');
  }
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
  if (!isHttpUrl(deps.baseURL)) {
    throw new TypeError(
      '@plakboek/auth: baseURL must be an absolute http or https URL',
    );
  }
}

/** Rethrows a failure from inside the audited mutation without anything a
 * query's parameters could have put into its message. */
function asInviteWriteError(error: unknown): InviteWriteError {
  return error instanceof InviteWriteError
    ? error
    : new InviteWriteError(error);
}

type StoredUser = {
  readonly id: string;
  readonly email: string;
  readonly roleKey: string | null;
};

async function findUserByAddress(
  tx: AuditTransaction,
  email: string,
): Promise<StoredUser | undefined> {
  const [found] = await tx
    .select({ id: user.id, email: user.email, roleKey: user.role })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return found;
}

type Invitee = {
  readonly userId: string;
  readonly email: string;
  readonly roleKey: string;
  readonly wasFirstUser: boolean;
  readonly created: boolean;
};

function existingInvitee(found: StoredUser): Invitee {
  return {
    userId: found.id,
    email: found.email,
    roleKey: found.roleKey ?? '',
    wasFirstUser: false,
    created: false,
  };
}

/**
 * The user an invite is for: the one that already holds the address, or a
 * new one created through the first-user rule. An address that already has
 * a user never gets a second row; the invite then does what a resend does.
 */
async function placeInvitee(
  tx: AuditTransaction,
  input: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly roleKey: string;
  },
): Promise<Invitee> {
  const existing = await findUserByAddress(tx, input.email);
  if (existing !== undefined) {
    return existingInvitee(existing);
  }
  try {
    const created = await createUserWithRole(tx, input);
    return {
      userId: created.userId,
      email: input.email,
      roleKey: created.roleKey,
      wasFirstUser: created.wasFirstUser,
      created: true,
    };
  } catch (error) {
    // A concurrent invite for the same address committed between the lookup
    // and the insert. The creation ran in its own savepoint, which rolled
    // back, so this transaction can still treat the address as taken.
    if (sqlStateOf(error) === UNIQUE_VIOLATION) {
      const raced = await findUserByAddress(tx, input.email);
      if (raced !== undefined) {
        return existingInvitee(raced);
      }
    }
    throw error;
  }
}

/**
 * The link purpose for a user, read from the database: `reset-password`
 * when they already have an email-and-password credential, `set-password`
 * when they have none. This is the one place the distinction is drawn. A
 * superadmin resending does not know which case applies.
 */
async function linkPurposeFor(
  tx: AuditTransaction,
  userId: string,
): Promise<PasswordLinkPurpose> {
  const [credential] = await tx
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, CREDENTIAL_PROVIDER_ID),
        isNotNull(account.password),
      ),
    )
    .limit(1);
  return credential === undefined ? 'set-password' : 'reset-password';
}

type PreparedLink = {
  readonly purpose: PasswordLinkPurpose;
  readonly outcome: PasswordLinkRequestOutcome;
  /** The rendered message, held back until the transaction has committed.
   * Absent for an unknown address, and when rendering failed. */
  readonly message: MailMessage | undefined;
  readonly renderFailure: unknown;
};

/**
 * Issues and renders a link inside the audited transaction, through
 * `requestPasswordLink`, and holds the message instead of sending it. The
 * sender handed to `requestPasswordLink` only records the message; the real
 * send happens in `deliver`, after the commit.
 */
async function prepareLink(
  tx: AuditTransaction,
  deps: InviteDeps,
  email: string,
  userId: string | undefined,
): Promise<PreparedLink> {
  const purpose =
    userId === undefined ? 'set-password' : await linkPurposeFor(tx, userId);
  const held: { message?: MailMessage; renderFailure?: unknown } = {};
  const outcome = await requestPasswordLink(
    {
      db: tx,
      mail: {
        send(message) {
          held.message = message;
          return Promise.resolve();
        },
      },
      ...(deps.renderEmail === undefined
        ? {}
        : { renderEmail: deps.renderEmail }),
      baseURL: deps.baseURL,
      onDeliveryError(error) {
        held.renderFailure = error;
      },
    },
    { email, purpose },
  );
  return {
    purpose,
    outcome,
    message: held.message,
    renderFailure: held.renderFailure,
  };
}

/** Sends a held message and waits for the transport to accept it. */
async function deliver(
  mail: MailSender,
  link: PreparedLink,
  userId: string,
  recipient: string,
): Promise<void> {
  const recipientDomain = domainOf(recipient);
  const { message } = link;
  if (message === undefined) {
    throw new InviteDeliveryError(userId, recipientDomain, link.renderFailure);
  }
  try {
    await mail.send(message);
  } catch (error) {
    throw new InviteDeliveryError(
      userId,
      recipientDomain,
      error instanceof MailSendError ? error : new MailSendError(message.to),
    );
  }
}

/**
 * Invites a user: creates them, issues a 48-hour set-password link and
 * mails it. Returns the user's id and whether they were the installation's
 * first user, in which case they hold `superadmin` whatever `roleKey` said.
 *
 * 1. The address, name, role key and optional id are checked before any
 *    work. A malformed one throws `InvalidInviteError`.
 * 2. `recorder.run` checks `users:create`. A caller without it gets a
 *    `denied` audit row and `PermissionDeniedError`, and nothing is created.
 * 3. In the audited transaction: the user is created through
 *    `createUserWithRole`, with no credential at all, so nothing can sign in
 *    as them until they complete the link. The link is then issued and its
 *    message rendered. If the address already has a user, no second row is
 *    created; the existing user is sent a link, exactly as a resend would.
 *    The audit row's `after` names the user id, the address's domain, the
 *    role key, whether a user was created, and the link purpose.
 * 4. After the commit the message is sent. A failure throws
 *    `InviteDeliveryError`; the user and the link stay.
 *
 * A failed statement throws `InviteWriteError` and commits nothing.
 */
export async function inviteUser(
  deps: InviteDeps,
  input: InviteUserInput,
): Promise<InviteUserResult> {
  assertInviteDeps(deps);
  const email = inviteAddress(input.email);
  const name = requiredText(input.name, 'name').trim();
  const roleKey = requiredText(input.roleKey, 'roleKey');
  const id =
    input.id === undefined ? randomUUID() : requiredText(input.id, 'id');

  const invited = await deps.recorder.run(
    input.actor,
    {
      permission: INVITE_PERMISSION,
      action: USER_INVITE_ACTION,
      entityType: 'user',
    },
    async (tx) => {
      try {
        const invitee = await placeInvitee(tx, { id, email, name, roleKey });
        const link = await prepareLink(tx, deps, invitee.email, invitee.userId);
        return {
          result: { invitee, link },
          after: {
            userId: invitee.userId,
            emailDomain: domainOf(invitee.email),
            roleKey: invitee.roleKey,
            created: invitee.created,
            linkPurpose: link.purpose,
          },
        };
      } catch (error) {
        throw asInviteWriteError(error);
      }
    },
  );

  const { invitee, link } = invited;
  await deliver(deps.mail, link, invitee.userId, invitee.email);
  return { userId: invitee.userId, wasFirstUser: invitee.wasFirstUser };
}

/**
 * Resends a user's password link and returns the same `{ delivered: true }`
 * whether or not the address belongs to a user.
 *
 * `recorder.run` checks `users:create`, the permission that invites.
 * `users:reset-password` alone is refused. In the audited transaction the
 * link is issued through `requestPasswordLink`, so an unknown address gets
 * the same rehearsed work and no message. The purpose comes from the
 * database: `set-password` for a user with no credential, `reset-password`
 * for one who already set a password, so a superadmin helping a locked-out
 * user is never silently ignored. The audit row's `after` names the user id
 * (when there is one), the address's domain, whether a user was found, and
 * the link purpose. After the commit the message is sent, and a failure
 * throws `InviteDeliveryError`.
 */
export async function resendSetPasswordLink(
  deps: InviteDeps,
  input: ResendSetPasswordLinkInput,
): Promise<PasswordLinkRequestOutcome> {
  assertInviteDeps(deps);
  // A resend never throws for a malformed address: it takes the
  // unknown-address path instead.
  const email = storedEmailForm(input.email);

  const resent = await deps.recorder.run(
    input.actor,
    {
      permission: RESEND_PERMISSION,
      action: USER_RESEND_SET_PASSWORD_ACTION,
      entityType: 'user',
    },
    async (tx) => {
      try {
        const target = await findUserByAddress(tx, email);
        // D-09 needs nothing extra here. issueSingleUseToken, which
        // requestPasswordLink calls, deletes every earlier outstanding link
        // of this purpose for this user in the transaction that inserts the
        // new one. Do not add a second cleanup: two rules for "only the
        // latest link is valid" can drift apart.
        const link = await prepareLink(tx, deps, email, target?.id);
        return {
          result: { target, link },
          after:
            target === undefined
              ? { emailDomain: domainOf(email), recipientFound: false }
              : {
                  userId: target.id,
                  emailDomain: domainOf(target.email),
                  recipientFound: true,
                  linkPurpose: link.purpose,
                },
        };
      } catch (error) {
        throw asInviteWriteError(error);
      }
    },
  );

  const { target, link } = resent;
  if (target !== undefined) {
    await deliver(deps.mail, link, target.id, target.email);
  }
  return link.outcome;
}
