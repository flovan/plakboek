/**
 * Single-use tokens for set-password, reset-password and magic-link links
 * (AUTH-03, AUTH-11, D-09).
 *
 * A token value is a bearer credential. It exists in three places only: the
 * return value of the issue call, the link sent to its owner, and the
 * argument of the consume call. It never reaches a log line, an error
 * message or an audit payload. Every other part of the system handles the
 * identifier stored in the database, never the value itself. That
 * identifier is `purpose:<SHA-256 of the value, base64url>`, so reading the
 * `verification` table (or a backup of it, or a failed query's parameters)
 * yields nothing that can be replayed as a link.
 *
 * Issuing deletes every earlier outstanding token of the same purpose for
 * the same subject in the transaction that inserts the new one, so only the
 * most recently issued link is valid (D-09). Consuming is a single
 * `DELETE ... RETURNING` inside the transaction that also performs the
 * authorised action: Postgres row locking lets exactly one of two racing
 * consumers see the row, and a failed action rolls the deletion back
 * (AUTH-11).
 *
 * Validity is strictly before `expiresAt`: at the instant of expiry a token
 * is already dead, so a 48-hour link is refused at the 48-hour mark.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import type { AuditDatabase, AuditTransaction } from './audit.js';
import { verification } from './schema.js';

/** The purpose namespaces. Each purpose prefixes its stored identifiers, so
 * tokens of different purposes never match or invalidate each other. */
export const TOKEN_PURPOSES = Object.freeze([
  'set-password',
  'reset-password',
  'magic-link',
] as const);

export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

const MILLISECONDS_PER_SECOND = 1000;

/** Returns the matching member of `TOKEN_PURPOSES`, so a prefix is always
 * built from the constant and never from a caller's string. */
function knownPurpose(purpose: unknown): TokenPurpose {
  const known = TOKEN_PURPOSES.find((candidate) => candidate === purpose);
  if (known === undefined) {
    throw new TypeError(
      `@plakboek/auth: token purpose must be one of ${TOKEN_PURPOSES.join(', ')}`,
    );
  }
  return known;
}

/** The `verification.identifier` form of a token: `purpose:token`. */
export function tokenIdentifier(purpose: TokenPurpose, token: string): string {
  return `${knownPurpose(purpose)}:${token}`;
}

/** 256 bits from the operating system's cryptographic random source,
 * base64url-encoded: 43 URL-safe characters with no padding. */
export function generateTokenValue(): string {
  return randomBytes(32).toString('base64url');
}

/** The instant a token issued at `issuedAt` stops being valid. The window
 * arrives as a parameter (see `SET_PASSWORD_TOKEN_TTL_SECONDS` and
 * `MAGIC_LINK_TTL_SECONDS` in `config.ts`); this module restates no
 * lifetime. */
export function expiryFor(issuedAt: Date, ttlSeconds: number): Date {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError(
      '@plakboek/auth: a token lifetime must be a positive whole number of seconds',
    );
  }
  const expiresAt = new Date(
    issuedAt.getTime() + ttlSeconds * MILLISECONDS_PER_SECOND,
  );
  if (Number.isNaN(expiresAt.getTime())) {
    throw new RangeError(
      '@plakboek/auth: could not compute a token expiry from the issue instant',
    );
  }
  return expiresAt;
}

/** True only while `now` is strictly before `expiresAt`. An invalid instant
 * on either side compares false, so it is never usable. */
export function isTokenUsable(
  row: { readonly expiresAt: Date },
  now: Date,
): boolean {
  return now.getTime() < row.expiresAt.getTime();
}

/**
 * The one rejection for a token that never existed, was already consumed or
 * has expired. The three causes are deliberately indistinguishable: telling
 * them apart would tell an attacker which guessed or intercepted values were
 * once real. Carries the purpose only -- never the token value or the
 * subject it belonged to.
 */
export class InvalidOrExpiredTokenError extends Error {
  readonly purpose: TokenPurpose;

  constructor(purpose: TokenPurpose) {
    const known = knownPurpose(purpose);
    super(`@plakboek/auth: this ${known} link is invalid or has expired`);
    this.name = 'InvalidOrExpiredTokenError';
    this.purpose = known;
  }
}

/** The database itself, or an enclosing transaction (which nests as a
 * savepoint). */
export type TokenDatabase = AuditDatabase;

/** The transaction handle the authorised action receives. Every write made
 * through it commits or rolls back with the token's consumption. */
export type TokenTransaction = AuditTransaction;

export type IssueSingleUseTokenInput = {
  readonly subjectId: string;
  readonly purpose: TokenPurpose;
  readonly ttlSeconds: number;
};

export type ConsumeSingleUseTokenInput = {
  readonly purpose: TokenPurpose;
  readonly token: string;
};

export type TokenClockOptions = {
  readonly now?: () => Date;
};

export type AuthorizeWithToken<T> = (
  tx: TokenTransaction,
  subjectId: string,
) => Promise<T>;

/**
 * First key of the transaction-scoped advisory lock taken while issuing.
 * The second key is a hash of `purpose:subjectId`. Postgres keeps two-key
 * advisory locks apart from single-bigint ones, so this never contends with
 * the migration or first-user locks.
 */
export const TOKEN_ISSUE_LOCK_CLASS = 1_702_125_873;

function defaultNow(): Date {
  return new Date();
}

/** The stored identifier for a token value: its purpose, then the value's
 * SHA-256 digest. The value itself is never written. */
function storedIdentifier(purpose: TokenPurpose, token: string): string {
  return tokenIdentifier(
    purpose,
    createHash('sha256').update(token, 'utf8').digest('base64url'),
  );
}

/**
 * Issues a token for `subjectId` and returns its value and expiry.
 *
 * Pass the caller's transaction to compose issuing with the caller's own
 * work; the statements then run in a savepoint and commit with it. A plain
 * database handle works too: the statements still run in one transaction
 * of their own, so the only-the-latest-link rule cannot be lost by a caller
 * forgetting to open one.
 *
 * Inside that transaction: a lock on this subject and purpose serialises
 * concurrent issues, every earlier outstanding token of the same purpose for
 * the same subject is deleted, and the new row is inserted. Without the lock,
 * two concurrent resends would each see no earlier row and both links would
 * stay valid.
 */
export async function issueSingleUseToken(
  tx: TokenDatabase,
  input: IssueSingleUseTokenInput,
  options?: TokenClockOptions,
): Promise<{ readonly token: string; readonly expiresAt: Date }> {
  const purpose = knownPurpose(input.purpose);
  const { subjectId } = input;
  if (typeof subjectId !== 'string' || subjectId.length === 0) {
    throw new TypeError(
      '@plakboek/auth: a token subject id must be a non-empty string',
    );
  }
  const issuedAt = (options?.now ?? defaultNow)();
  const expiresAt = expiryFor(issuedAt, input.ttlSeconds);
  const token = generateTokenValue();

  await tx.transaction(async (issuing) => {
    await issuing.execute(
      sql`SELECT pg_advisory_xact_lock(${TOKEN_ISSUE_LOCK_CLASS}::int4, hashtext(${`${purpose}:${subjectId}`}))`,
    );
    // The prefix comes from the TOKEN_PURPOSES member, never from the
    // caller's string, and no purpose contains a LIKE wildcard.
    await issuing
      .delete(verification)
      .where(
        and(
          eq(verification.value, subjectId),
          like(verification.identifier, `${purpose}:%`),
        ),
      );
    await issuing.insert(verification).values({
      id: randomUUID(),
      identifier: storedIdentifier(purpose, token),
      value: subjectId,
      expiresAt,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    });
  });

  return { token, expiresAt };
}

/**
 * Consumes `token` and runs `authorize` for the subject it was issued to,
 * in one transaction, returning what `authorize` returns.
 *
 * The consumption is a single `DELETE ... RETURNING`. When two transactions
 * race for the same row, the second blocks on the first's row lock and, once
 * the first commits, finds nothing, so exactly one of them authorises. An
 * unknown, already-consumed or expired token throws
 * `InvalidOrExpiredTokenError`; for an expired row that throw also rolls the
 * deletion back, so nothing is silently swept. If `authorize` throws, the
 * transaction rolls back, the token stays valid, and its error propagates
 * unchanged.
 */
export async function consumeSingleUseToken<T>(
  db: TokenDatabase,
  input: ConsumeSingleUseTokenInput,
  authorize: AuthorizeWithToken<T>,
  options?: TokenClockOptions,
): Promise<T> {
  const purpose = knownPurpose(input.purpose);
  if (typeof authorize !== 'function') {
    throw new TypeError('@plakboek/auth: authorize must be a function');
  }
  const { token } = input;
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidOrExpiredTokenError(purpose);
  }
  const identifier = storedIdentifier(purpose, token);
  const now = options?.now ?? defaultNow;

  return await db.transaction(async (tx) => {
    const consumed = await tx
      .delete(verification)
      .where(eq(verification.identifier, identifier))
      .returning({
        subjectId: verification.value,
        expiresAt: verification.expiresAt,
      });
    const [row] = consumed;
    if (
      row === undefined ||
      consumed.length !== 1 ||
      !isTokenUsable(row, now())
    ) {
      throw new InvalidOrExpiredTokenError(purpose);
    }
    return await authorize(tx, row.subjectId);
  });
}
