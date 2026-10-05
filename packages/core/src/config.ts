/**
 * `defineConfig`: composes the engine packages' own validating doors
 * (`defineContentConfig`, `defineBlocks`, `definePagesConfig`, `defineRoles`)
 * into one frozen host configuration. Server-side only; a block file imports
 * `defineBlock` from the package root instead.
 */
import { defineContentConfig } from '@plakboek/content';
import { defaultRoles, defineRoles } from '@plakboek/permissions';
import {
  DEFAULT_HOME_SLUG,
  defineBlocks,
  definePagesConfig,
} from '@plakboek/pages';
import type { PlakboekConfig, PlakboekConfigInput } from './types.js';

export type PlakboekConfigIssueCode =
  | 'INVALID_SITE_NAME'
  | 'INVALID_MENU'
  | 'INVALID_MENU_ITEM'
  | 'INVALID_MODULE'
  | 'DUPLICATE_MODULE'
  | 'INVALID_SEED'
  | 'UNKNOWN_SEED_BLOCK'
  | 'SEED_ROOT_NOT_SECTION';

export type PlakboekConfigIssue = {
  readonly code: PlakboekConfigIssueCode;
  readonly message: string;
};

export class PlakboekConfigError extends Error {
  readonly issues: readonly PlakboekConfigIssue[];

  constructor(issues: readonly PlakboekConfigIssue[]) {
    super('[@plakboek/core] invalid config:');
    this.name = 'PlakboekConfigError';
    this.issues = issues;
  }
}

export { defaultRoles };

export function defineConfig(input: PlakboekConfigInput): PlakboekConfig {
  const content = defineContentConfig({
    locales: input.locales,
    defaultLocale: input.defaultLocale,
    timezone: input.timezone,
  });
  const pages = definePagesConfig({
    content,
    blocks: defineBlocks([...input.blocks]),
    ...(input.fieldTypes === undefined ? {} : { fieldTypes: input.fieldTypes }),
    ...(input.widgets === undefined ? {} : { widgets: input.widgets }),
    ...(input.constraints === undefined
      ? {}
      : { constraints: input.constraints }),
    ...(input.sectionNestingDepth === undefined
      ? {}
      : { sectionNestingDepth: input.sectionNestingDepth }),
    ...(input.blockDepthCeiling === undefined
      ? {}
      : { blockDepthCeiling: input.blockDepthCeiling }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  const roles = defineRoles(input.roles ?? defaultRoles);
  const seed =
    input.seed === undefined
      ? null
      : typeof input.seed === 'function'
        ? input.seed()
        : input.seed;

  return Object.freeze({
    siteName: input.siteName,
    content,
    pages,
    roles,
    menus: Object.freeze({ ...input.menus }),
    modules: Object.freeze((input.modules ?? []).map((m) => m.name)),
    seed,
    homeSlug: DEFAULT_HOME_SLUG,
  });
}
