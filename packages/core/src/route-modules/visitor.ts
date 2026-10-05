/**
 * The visitor resource route: a loader and no default export, so no client
 * chunk exists for it and the Response is returned verbatim.
 */
import type { LoaderFunctionArgs } from 'react-router';
import { getHostRuntime } from '../runtime/host.js';

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return await getHostRuntime().visitor(request);
}
