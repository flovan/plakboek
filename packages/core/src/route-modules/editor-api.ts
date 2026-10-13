/**
 * The editor's JSON API resource route (`/cms/api/*`): a loader and an
 * action, no default export, so no client chunk exists for it and every
 * Response is returned verbatim. The editor's API owns method, origin and
 * session checks; this module adds the `/cms` rules: `X-Robots-Tag` on every
 * answer, errors included, and a plain 500 that names nothing on a throw.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { cmsGuard } from '../cms-headers.js';
import { getHostRuntime } from '../runtime/host.js';

function jsonNotFound(): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code: 'not-found' } }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

function serve({ request }: LoaderFunctionArgs): Promise<Response> {
  return cmsGuard(async () => {
    const api = await getHostRuntime().editorApi();
    return (await api.handle(request)) ?? jsonNotFound();
  });
}

export function loader(args: LoaderFunctionArgs): Promise<Response> {
  return serve(args);
}

export function action(args: ActionFunctionArgs): Promise<Response> {
  return serve(args);
}
