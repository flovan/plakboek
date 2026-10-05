/**
 * The only module that imports the virtual host module the `plakboek()` Vite
 * plugin generates.
 */
import * as host from 'virtual:plakboek/host';
import { runtimeFor, type Runtime } from './runtime.js';

export function getHostRuntime(): Runtime {
  return runtimeFor(host);
}
