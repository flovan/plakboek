import type { ModuleDefinition } from './types.js';

export const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return { ...definition, name: '' };
}
