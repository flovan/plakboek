/**
 * Root entry for @plakboek/render: the block-authoring contract.
 *
 * Safe to import from any bundle, including the editor and every block
 * module. It imports no `react-dom/server`, no `drizzle-orm`, no
 * `@plakboek/pages` value and no `node:` builtin; everything server-side
 * lives behind `@plakboek/render/server`.
 */

// constants
export {
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  TOOLBAR_DISMISSED_KEY,
} from './constants.js';

// block-component
export type {
  BlockComponent,
  BlockComponentProps,
  BlockIdentity,
} from './block-component.js';

// head
export type { DocumentInput, PageHead, RenderDocument } from './head.js';

// edit-proxy
export { NOOP_EDIT } from './edit-proxy.js';
export type { EditAttributes, EditProxy } from './edit-proxy.js';
