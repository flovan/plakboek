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

/** The outcome of a capped read: the bytes, or a body over the cap. */
export type BodyRead =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreadable' };

/**
 * Reads a request body of at most `maxBytes`, in every runtime. A declared
 * Content-Length over the cap, or one that is not a plain integer, is refused
 * without touching the body. It is never trusted as an upper bound, though:
 * the bytes are counted as they arrive and the stream is cancelled the moment
 * the count passes the cap, so a header that understates the body gains
 * nothing.
 */
export async function readBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<BodyRead> {
  const declared = request.headers.get('content-length')?.trim();
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
      return { kind: 'too-large' };
    }
  }
  if (request.body === null) return { kind: 'bytes', bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'unreadable' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'bytes', bytes };
}
