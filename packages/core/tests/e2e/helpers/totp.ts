/** The authenticator app's side of two-step sign-in, for the e2e specs. */
import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

/** The bytes of an RFC 4648 base32 string, as an otpauth secret is written. */
function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of encoded.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('the otpauth secret has a character outside base32');
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

/**
 * The code an authenticator app shows for a base32 secret at a time
 * (milliseconds since the epoch, now by default): RFC 6238 with the app
 * defaults, HMAC-SHA1 over the 30-second counter, dynamic truncation, six
 * digits.
 */
export function totp(secretBase32: string, time: number = Date.now()): string {
  const counter = Math.floor(time / 1000 / PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32))
    .update(message)
    .digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The base32 secret inside an `otpauth://` URI. */
export function secretOfOtpauthUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (secret === null || secret === '') {
    throw new Error('the otpauth URI carries no secret');
  }
  return secret;
}

/** A six-digit code the app cannot be showing: it differs from the codes of
 * the previous, current and next period, which the server accepts. */
export function wrongTotp(
  secretBase32: string,
  time: number = Date.now(),
): string {
  const accepted = new Set(
    [-1, 0, 1].map((step) => totp(secretBase32, time + step * 30_000)),
  );
  for (let candidate = 0; candidate < 10; candidate += 1) {
    const code = String(candidate).repeat(DIGITS);
    if (!accepted.has(code)) return code;
  }
  throw new Error('no wrong code was found');
}
