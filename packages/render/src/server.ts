/**
 * Server entry for @plakboek/render: the renderers that need server-only
 * code (`react-dom/server`). Never import this from a browser bundle; the
 * block-authoring contract lives on the root entry.
 */

// head
export { buildPageHead, renderHeadHtml } from './head.js';
export type { PageHeadInput, PageSeoInput } from './head.js';

// document
export { renderDefaultDocument } from './document.js';

// components
export { createComponentMap } from './components.js';
export type { ComponentMap } from './components.js';

// hooks
export type {
  BlockRenderErrorEvent,
  CacheErrorEvent,
  MissingComponentEvent,
  RenderErrorEvent,
  RenderHooks,
  UnknownBlockEvent,
} from './hooks.js';

// render-snapshot
export { renderPageSnapshot } from './render-snapshot.js';
export type {
  RenderedPage,
  RenderPageSnapshotInput,
} from './render-snapshot.js';

// live-edit
export { createLiveEdit } from './live-edit.js';
export type { LiveEditInput } from './live-edit.js';

// render-tree
export { renderPageTree } from './render-tree.js';
export type {
  BlockMeta,
  RenderedTree,
  RenderPageTreeInput,
} from './render-tree.js';

// render-fragment
export { renderBlockFragments } from './render-fragment.js';
export type {
  RenderBlockFragmentsInput,
  RenderedFragment,
  RenderedFragments,
} from './render-fragment.js';

// path
export { normalizeVisitorPath } from './path.js';
export type { VisitorPathResult } from './path.js';

// handler
export { createVisitorHandler, VisitorHandlerConfigError } from './handler.js';
export type {
  VisitorHandler,
  VisitorHandlerConfigIssue,
  VisitorHandlerDeps,
} from './handler.js';

// edit-seam
export {
  renderToolbarBootstrap,
  TOOLBAR_BOOTSTRAP_CSP_HASH,
} from './edit-seam.js';
export type { EditEntrypoint, EditRequestContext } from './edit-seam.js';
