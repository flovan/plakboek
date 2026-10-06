/**
 * The better-auth mount at `/api/auth/*`: a loader and an action that hand
 * the request to better-auth's own handler. Its built-in production rate
 * limiter and this package's closed routes (no public sign-up) stay in force.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getHostRuntime } from '../runtime/host.js';

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return await getHostRuntime().auth.handler(request);
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return await getHostRuntime().auth.handler(request);
}
