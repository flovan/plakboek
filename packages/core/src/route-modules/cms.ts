/**
 * The `/cms` resource route, for `/cms` itself and every path under it that no
 * more specific CMS route claims: a loader and an action, no default export,
 * so no client chunk exists for it and every Response is returned verbatim.
 *
 * The editor's pages handler answers the login document and the landings of
 * emailed links. Anything else under `/cms` is the host's own 404, never a
 * visitor page, and every answer carries `X-Robots-Tag: noindex, nofollow`.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { cmsGuard, withCmsHeaders } from '../cms-headers.js';
import { getHostRuntime } from '../runtime/host.js';

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return await cmsGuard(async () => {
    const runtime = getHostRuntime();
    const pages = await runtime.cmsPages();
    return (
      (await pages.handle(request)) ?? (await runtime.notFoundResponse(request))
    );
  });
}

/** The login form posts here without a script: refused, so a password never
 * lands in an address. Carries the same header every other answer does. */
export function action(_args: ActionFunctionArgs): Response {
  return withCmsHeaders(
    new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }),
  );
}
