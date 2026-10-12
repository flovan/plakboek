/**
 * The health resource route: a loader and no default export, so no client
 * chunk exists for it. Usable by a compose healthcheck and the deploy step.
 * Like every `/cms` answer, an error or a refused method carries
 * `X-Robots-Tag` too.
 */
import type { ActionFunctionArgs } from 'react-router';
import { cmsGuard } from '../cms-headers.js';
import { healthResponse } from '../health.js';
import { getHostRuntime } from '../runtime/host.js';

export async function loader(): Promise<Response> {
  return await cmsGuard(async () => await healthResponse(getHostRuntime().db));
}

/** Health is read-only: any other method is refused, not left to React
 * Router's own bare 405. */
export function action(_args: ActionFunctionArgs): Promise<Response> {
  return cmsGuard(
    () =>
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
