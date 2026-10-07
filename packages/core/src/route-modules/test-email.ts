/**
 * The setup screen's "Send test email" route. The action is the only way in;
 * a GET is the host's own 404, so the URL reveals nothing.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getHostRuntime } from '../runtime/host.js';
import { handleTestEmailPost } from '../setup/handlers.js';
import { createSendLimiter } from '../setup/token.js';

/** One counter per process; a restart resets it (acceptable: self-addressed). */
const limiter = createSendLimiter({ max: 5, maxEntries: 1000 });

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return await getHostRuntime().notFoundResponse(request);
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return await handleTestEmailPost(request, getHostRuntime(), limiter);
}
