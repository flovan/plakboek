/**
 * The visitor resource route: a loader and no default export, so no client
 * chunk exists for it and the Response is returned verbatim.
 */
import type { LoaderFunctionArgs } from 'react-router';
import { injectDevClient } from '../dev-client.js';
import { getHostRuntime } from '../runtime/host.js';

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  const response = await getHostRuntime().visitor(request);
  // Statically replaced by the host's Vite build, so the production server
  // bundle drops this branch and visitor pages carry only the toolbar script.
  return import.meta.env.DEV ? await injectDevClient(response) : response;
}
