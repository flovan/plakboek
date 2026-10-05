/**
 * Modules: a named bundle of blocks, field types, widgets and constraints a
 * host lists in `modules: [...]`. Client-safe; the merge happens in
 * `defineConfig`.
 */
import type { ModuleDefinition } from './types.js';

export const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Declares one module. An identity function with inference: it adds no
 * runtime behaviour. The name is validated, and contributions merged, when
 * `defineConfig` receives it.
 */
export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return definition;
}
