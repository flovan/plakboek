/**
 * Server-only React walk of a published snapshot into a head and a body.
 *
 * The body is ONE `renderToStaticMarkup` call (D-28): every block, section
 * or not, goes through the shared `BlockHost` recursion (04 D-16, see
 * `block-host.tsx`), so no branch on a block's `kind` exists here and the
 * containment rules (D-14, D-29) are the ones the live tree renderer uses.
 * A block that throws, whose output throws, or that returns a promise is
 * dropped together with its subtree, reported, and marks the render
 * `degraded` so the handler serves it uncached. Only an error outside every
 * block (the head, the document composer) still fails the whole render, which
 * the handler turns into an uncached 500.
 *
 * A visitor page always passes `NOOP_EDIT` and no placeholder.
 */
import { GLOBAL_TAG, pageTag } from '@plakboek/cache';
import type { PublishedPageView } from '@plakboek/pages';
import { NOOP_EDIT } from './edit-proxy.js';
import { renderBlocks } from './block-host.js';
import type { ComponentMap } from './components.js';
import { buildPageHead, type PageHead } from './head.js';
import type { RenderHooks } from './hooks.js';

export type RenderPageSnapshotInput = {
  readonly view: PublishedPageView;
  readonly publicPath: string;
  readonly components: ComponentMap;
  readonly hooks?: RenderHooks;
  readonly siteUrl?: string;
  readonly resolveAssetUrl?: (assetId: string) => string | null;
};

export type RenderedPage = {
  readonly head: PageHead;
  readonly body: string;
  /** Every cache tag the rendered page depends on. */
  readonly tags: readonly string[];
  /** Whether any block failed to render; a degraded page is not cached. */
  readonly degraded: boolean;
};

/** Renders a published page's snapshot; never touches the database. */
export function renderPageSnapshot(
  input: RenderPageSnapshotInput,
): RenderedPage {
  const { view, components, hooks } = input;
  const pageId = view.page.id;
  const head = buildPageHead({
    lang: view.page.locale,
    pageTitle: view.page.title,
    seo: view.page.seo,
    publicPath: input.publicPath,
    siteUrl: input.siteUrl,
    resolveAssetUrl: input.resolveAssetUrl,
  });
  const { body, degraded } = renderBlocks(view.publication.snapshot.blocks, {
    components,
    hooks,
    pageId,
    editFor: () => NOOP_EDIT,
  });
  return {
    head,
    body,
    tags: [GLOBAL_TAG, pageTag(pageId)],
    degraded,
  };
}
