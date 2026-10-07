import type { HostBlockDefinition } from './types.js';

/**
 * Declares one block. An identity function with inference: it adds no
 * runtime behaviour, so a block file stays safe to import from a client
 * bundle. The definition is validated when `defineConfig` receives it.
 */
export function defineBlock<P = never>(
  definition: HostBlockDefinition<P>,
): HostBlockDefinition<P> {
  return definition;
}
