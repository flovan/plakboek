/**
 * What the two-step set-up step works out from the key the auth service hands
 * back. Pure functions, so they are tested without a browser. Nothing here
 * stores anything: the key and the backup codes live in the card's state for
 * as long as the step is on screen and no longer.
 */

/** What an authenticator link carries. */
export type OtpauthKey = {
  /** The base32 secret an authenticator app holds. */
  readonly secret: string;
  readonly issuer: string;
  /** The account the key belongs to, normally the user's address. */
  readonly account: string;
};

/**
 * Reads an `otpauth://totp/<issuer>:<account>?secret=...&issuer=...` link.
 * Anything else, and a link with no secret, answers `null`: the card then
 * has no key to show and says something went wrong instead of rendering an
 * address it cannot vouch for.
 */
export function parseOtpauthUri(uri: string): OtpauthKey | null {
  if (!uri.startsWith('otpauth://')) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const secret = url.searchParams.get('secret');
  if (secret === null || secret === '') return null;

  let label: string;
  try {
    label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  const colon = label.indexOf(':');
  const labelIssuer = colon === -1 ? '' : label.slice(0, colon);
  const account = colon === -1 ? label : label.slice(colon + 1);
  return {
    secret,
    issuer: url.searchParams.get('issuer') ?? labelIssuer,
    account,
  };
}

/** A setup key written in groups of four, easier to read off and to type. */
export function groupSetupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}
