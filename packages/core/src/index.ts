/**
 * Root entry for @plakboek/core: the block-authoring surface.
 *
 * Safe to import from any bundle, including the editor and every block
 * module. It imports no `node:` builtin, no database driver and no
 * `@plakboek/pages` value; everything server-side lives behind the
 * `./config`, `./routes`, `./vite` and `./server` subpaths.
 */

// blocks
export { defineBlock } from './blocks.js';

// types
export type {
  HostBlockDefinition,
  HostModule,
  MenuDefinitions,
  MenuItem,
  MenuLabel,
  ModuleDefinition,
  PlakboekConfig,
  PlakboekConfigInput,
  ResolvedMenuItem,
  SeedBlock,
  SeedPage,
  SiteContext,
  SiteModule,
} from './types.js';
