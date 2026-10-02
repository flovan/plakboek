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
