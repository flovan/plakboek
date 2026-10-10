/**
 * `POST /cms/logout`: ends the session on the server and returns the browser
 * to the page it left, without `_edit`. The edit shell's Log out control is a
 * plain form posting here, so it works before any script has run.
 *
 * A state-changing request from a form is checked against cross-site
 * forgery: the `Origin` header must be this site's, or, when a browser sends
 * none, `Sec-Fetch-Site` must say `same-origin`. The body is read through a
 * 2 KB cap, and `next` goes through the same sanitiser every other `next`
 * does, so the redirect can only ever stay on this site.
 */
import { sanitizeNextPath } from '@plakboek/auth';
import type { ActionFunctionArgs } from 'react-router';
import { withCmsHeaders } from '../cms-headers.js';
import { getHostRuntime } from '../runtime/host.js';
import type { Runtime } from '../runtime/runtime.js';
import { payloadTooLarge, readBodyWithinLimit } from '../setup/body-limit.js';

/** A logout form carries one short field. */
const LOGOUT_BODY_LIMIT_BYTES = 2 * 1024;

function plain(
  status: number,
  text: string,
  extra: Record<string, string> = {},
): Response {
  return withCmsHeaders(
    new Response(text, {
      status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extra,
      },
    }),
  );
}

/**
 * Whether the request came from this site's own pages. `PLAKBOEK_URL` is
 * authoritative; the request's own origin is accepted too, because behind a
 * TLS-terminating proxy the two can legitimately differ and a foreign page
 * can forge neither. Without an `Origin` header only a browser's own
 * `Sec-Fetch-Site: same-origin` counts.
 */
function isOwnRequest(request: Request, runtime: Runtime): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return request.headers.get('Sec-Fetch-Site') === 'same-origin';
  }
  const allowed = new Set<string>([new URL(runtime.env.siteUrl).origin]);
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    // An unparseable request URL contributes no origin.
  }
  return allowed.has(origin);
}

/** What the capped read of the form body found. */
type LogoutForm =
  | { readonly kind: 'ok'; readonly next: string | null }
  | { readonly kind: 'too-large' };

/** The `next` field of the form body, read through the cap. A body that is
 * not a form, or has no such field, has no `next`. */
async function readLogoutForm(request: Request): Promise<LogoutForm> {
  const read = await readBodyWithinLimit(request, LOGOUT_BODY_LIMIT_BYTES);
  if (read.kind === 'too-large') return { kind: 'too-large' };
  if (read.kind !== 'bytes') return { kind: 'ok', next: null };
  try {
    const form = await new Response(read.bytes, {
      headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' },
    }).formData();
    const value = form.get('next');
    return { kind: 'ok', next: typeof value === 'string' ? value : null };
  } catch {
    return { kind: 'ok', next: null };
  }
}

/** Only a POST logs out. */
export function loader(): Response {
  return plain(405, 'Method Not Allowed', { Allow: 'POST' });
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  const runtime = getHostRuntime();
  if (!isOwnRequest(request, runtime)) return plain(403, 'Forbidden');

  const form = await readLogoutForm(request);
  if (form.kind === 'too-large') return withCmsHeaders(payloadTooLarge());
  const next = sanitizeNextPath(form.next);

  const headers = new Headers({ Location: next, 'Cache-Control': 'no-store' });
  try {
    const signedOut = await runtime.auth.api.signOut({
      headers: request.headers,
      asResponse: true,
    });
    // Every cookie the sign-out clears must reach the browser.
    for (const cookie of signedOut.headers.getSetCookie()) {
      headers.append('Set-Cookie', cookie);
    }
  } catch {
    // No session to end (already signed out, or an expired cookie): the
    // visitor still lands on the page without `_edit`, which is the point.
  }
  return withCmsHeaders(new Response(null, { status: 303, headers }));
}
