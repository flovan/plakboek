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
