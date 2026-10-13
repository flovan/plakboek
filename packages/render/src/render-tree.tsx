/**
 * Server-only React walk of a live working tree (`BlockNode[]`) into a head
 * and a body, for the editor's frame document (D-20, D-29).
 *
 * It runs the same `BlockHost` recursion as the visitor snapshot path, so one
 * throwing block is dropped with its subtree and reported while the rest of
 * the page renders. The difference is what an edit render adds:
 *
 * - `live`: every block receives a live proxy (`createLiveEdit`), and a block
 *   that would render nothing (unknown type, no component, degraded, throwing,
 *   async) is replaced by an inert placeholder carrying the same attributes
 *   plus `data-pk-unavailable` (the reason), so the overlay has something to
 *   outline.
 * - `plain`: `NOOP_EDIT` and no placeholder, so a read-only viewer of a
 *   working tree receives visitor-identical markup.
 *
 * No wrapper element is ever added around a block a host renders.
 */
import type { BlockNode, PublishedPageSeo } from '@plakboek/pages';
import { renderBlocks, type PlaceholderReason } from './block-host.js';
import type { ComponentMap } from './components.js';
import { NOOP_EDIT, type EditProxy } from './edit-proxy.js';
import { buildPageHead, type PageHead } from './head.js';
import type { RenderHooks } from './hooks.js';
import { createLiveEdit, EDIT_ATTRIBUTE } from './live-edit.js';
import type { ReactNode } from 'react';

/** What the overlay needs to know about a block type. */
export type BlockMeta = {
  readonly label: string;
  readonly kind: 'section' | 'column' | 'block';
};

export type RenderPageTreeInput = {
  readonly page: {
    readonly id: string;
    readonly locale: string;
    readonly title: string;
    readonly seo: PublishedPageSeo;
  };
  readonly blocks: readonly BlockNode[];
  readonly publicPath: string;
  readonly components: ComponentMap;
  /** Label and kind per block type key; a missing type falls back to its key. */
  readonly blockMeta: ReadonlyMap<string, BlockMeta>;
  readonly mode: 'live' | 'plain';
  readonly hooks?: RenderHooks;
  readonly siteUrl?: string;
  readonly resolveAssetUrl?: (assetId: string) => string | null;
};

export type RenderedTree = {
  readonly head: PageHead;
  readonly body: string;
  /** Whether any block failed to render or was degraded. */
  readonly degraded: boolean;
};

/**
 * The edit-only stand-in: a hoverable box with the attributes of the block it
 * replaces and nothing else. Its kind and label come from the same block
 * metadata a rendering block's proxy gets, so a section that fails is still a
 * section to the overlay, and `data-pk-unavailable` says why it is a stand-in:
 * `unknown` (no such type or component), `degraded` (stored below the type's
 * compatibility floor) or `failed` (it threw or could not render).
 */
function placeholderFor(
  blockMeta: ReadonlyMap<string, BlockMeta>,
): (node: BlockNode, reason: PlaceholderReason) => ReactNode {
  return (node, reason) => {
    const meta = blockMeta.get(node.blockType);
    return (
      <div
        {...{
          [EDIT_ATTRIBUTE.block]: node.id,
          [EDIT_ATTRIBUTE.type]: node.blockType,
          [EDIT_ATTRIBUTE.kind]: meta?.kind ?? 'block',
          [EDIT_ATTRIBUTE.label]: meta?.label ?? node.blockType,
          [EDIT_ATTRIBUTE.unavailable]: reason,
        }}
        style={{ minHeight: '40px' }}
      />
    );
  };
}

/** Renders a live working tree; never touches the database. */
export function renderPageTree(input: RenderPageTreeInput): RenderedTree {
  const { page, blockMeta } = input;
  const live = input.mode === 'live';
  const head = buildPageHead({
    lang: page.locale,
    pageTitle: page.title,
    seo: page.seo,
    publicPath: input.publicPath,
    siteUrl: input.siteUrl,
    resolveAssetUrl: input.resolveAssetUrl,
  });
  const editFor = (node: BlockNode): EditProxy => {
    if (!live) return NOOP_EDIT;
    const meta = blockMeta.get(node.blockType);
    return createLiveEdit({
      id: node.id,
      blockType: node.blockType,
      kind: meta?.kind ?? 'block',
      label: meta?.label ?? node.blockType,
    });
  };
  const { body, degraded } = renderBlocks(input.blocks, {
    components: input.components,
    hooks: input.hooks,
    pageId: page.id,
    editFor,
    isDegraded: (node) => node.degraded,
    placeholderFor: live ? placeholderFor(blockMeta) : undefined,
  });
  return { head, body, degraded };
}
