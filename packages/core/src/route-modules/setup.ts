/**
 * The first-run resource route: a loader and an action, no default export,
 * so no client chunk exists for it and every Response is returned verbatim.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { cmsGuard } from '../cms-headers.js';
import { handleSetupGet, handleSetupPost } from '../setup/handlers.js';
import { getHostRuntime } from '../runtime/host.js';

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  return await cmsGuard(
    async () => await handleSetupGet(request, getHostRuntime()),
  );
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return await cmsGuard(
    async () => await handleSetupPost(request, getHostRuntime()),
  );
}
