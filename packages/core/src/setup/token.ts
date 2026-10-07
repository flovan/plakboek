/**
 * The signed, expiring token that authorises "Send test email" on the setup
 * complete screen (D-10), and the in-memory cap on how often one token can
 * send.
 *
 * There is no session after setup (D-13) and `/cms/setup` disappears once a
 * user exists, so the screen carries its own proof. The token is stateless:
 *
 *   base64url(JSON { u: userId, p: homePublished, n: random id, e: expiry ms })
 *   + '.' + base64url(HMAC-SHA256(payload))
 *
 * The HMAC key is a sub-key derived from `PLAKBOEK_SECRET` for this purpose
 * only, so a signature made here is useless anywhere else the secret is used.
 * The token names a user; it never carries an address, and the endpoint reads
 * the address from the database, so a holder cannot aim the mail anywhere.
 */
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from 'node:crypto';

/** A token stops working 15 minutes after it was issued. */
export const TEST_EMAIL_TOKEN_TTL_MS = 15 * 60 * 1000;

const KEY_PURPOSE = 'plakboek:setup-test-email:v1';

/** A real token is a few hundred characters; anything longer is not one. */
const MAX_TOKEN_LENGTH = 1024;

export type VerifiedTestEmailToken = {
  readonly userId: string;
  readonly homePublished: boolean;
  /** Identifies this token for the send cap. */
  readonly tokenId: string;
};

function hmac(key: BinaryLike, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret: string): Buffer {
  return hmac(secret, KEY_PURPOSE);
}

function sign(secret: string, payload: string): string {
  return hmac(signingKey(secret), payload).toString('base64url');
}

export function createTestEmailToken(options: {
  readonly secret: string;
  readonly userId: string;
  readonly homePublished: boolean;
  /** Epoch milliseconds; tests inject it. */
  readonly now?: number;
}): string {
  const issuedAt = options.now ?? Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      u: options.userId,
      p: options.homePublished,
      n: randomBytes(12).toString('base64url'),
      e: issuedAt + TEST_EMAIL_TOKEN_TTL_MS,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(options.secret, payload)}`;
}

/** Compares two strings in constant time; different lengths never match. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The token's claims, or `null` for anything wrong with it: malformed, forged,
 * signed with another secret, tampered with or expired. The reason is never
 * reported, so a caller cannot tell the cases apart.
 */
export function verifyTestEmailToken(
  token: string,
  options: { readonly secret: string; readonly now?: number },
): VerifiedTestEmailToken | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload = '', signature = ''] = parts;
  if (payload.length === 0 || signature.length === 0) return null;

  // Compared as encoded text, not decoded bytes: a base64url tail carries
  // unused bits, and a changed final character must still be a mismatch.
  if (!sameText(signature, sign(options.secret, payload))) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const { u, p, n, e } = claims as Record<string, unknown>;
  if (
    typeof u !== 'string' ||
    u.length === 0 ||
    typeof p !== 'boolean' ||
    typeof n !== 'string' ||
    typeof e !== 'number' ||
    !Number.isFinite(e)
  ) {
    return null;
  }
  if ((options.now ?? Date.now()) > e) return null;
  return { userId: u, homePublished: p, tokenId: n };
}

export type SendLimiter = {
  /** Counts one send for the token; `false` once its allowance is used up. */
  consume(tokenId: string): boolean;
  /** How many token ids are being counted. */
  size(): number;
};

/**
 * An in-memory counter per token id. A restart resets it, which is acceptable
 * for a single-process, self-addressed send. The oldest id is dropped when the
 * map is full, so memory stays bounded however many tokens are tried.
 */
export function createSendLimiter(
  options: { readonly max?: number; readonly maxEntries?: number } = {},
): SendLimiter {
  const max = options.max ?? 5;
  const maxEntries = options.maxEntries ?? 1000;
  const counts = new Map<string, number>();

  return {
    consume(tokenId) {
      const used = counts.get(tokenId) ?? 0;
      if (used >= max) return false;
      counts.delete(tokenId);
      counts.set(tokenId, used + 1);
      while (counts.size > maxEntries) {
        const oldest = counts.keys().next();
        if (oldest.done === true) break;
        counts.delete(oldest.value);
      }
      return true;
    },
    size: () => counts.size,
  };
}
