/**
 * The health resource route: a loader and no default export, so no client
 * chunk exists for it. Usable by a compose healthcheck and the deploy step.
 */
import { healthResponse } from '../health.js';
import { getHostRuntime } from '../runtime/host.js';

export async function loader(): Promise<Response> {
  return await healthResponse(getHostRuntime().db);
}
