/**
 * The size cap on the first-run POST endpoints (T-06-86). Both are reachable
 * without authentication, so an unbounded body would let any client exhaust
 * the app's memory. This module imports nothing from Hono: the route-module
 * chunks use it too.
 */

/**
 * 16 KiB. A real setup submission is four short urlencoded text fields (a
 * name of at most 200 code points, an email of at most 320 characters and two
 * passwords), which stays under about 8 KiB even with every character
 * percent-encoded. The test-email body is one token of about 200 bytes.
 */
export const SETUP_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Whether a request path belongs to the setup endpoints. Case-insensitive on
 * purpose: React Router matches routes case-insensitively, so a case-sensitive
 * guard could be bypassed with `/CMS/Setup`.
 */
export function isSetupPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === '/cms/setup' || path.startsWith('/cms/setup/');
}

/**
 * The 413 for a body over the cap: fixed text, uncacheable, unindexable and
 * nothing taken from the request. No `Connection: close`: closing a socket
 * that still holds unread request bytes can reset it before the client reads
 * the answer.
 */
export function payloadTooLarge(): Response {
  return new Response('Payload Too Large', {
    status: 413,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
