/**
 * Server-only fragment renderer for the editor (D-24, D-28): turns any block
 * of a live working tree, with its subtree, into the markup the frame
 * document shows for it.
 *
 * It walks the same `BlockHost` recursion as `renderPageTree`, with the same
 * live proxy and the same edit placeholders, so a fragment is byte-identical
 * to that block's markup inside a full frame render. Nothing here touches
 * the database.
 */
import type { BlockNode } from '@plakboek/pages';
import { renderBlocks } from './block-host.js';
import type { ComponentMap } from './components.js';
import type { RenderHooks } from './hooks.js';
import { liveEditFor, placeholderFor, type BlockMeta } from './render-tree.js';

export type RenderBlockFragmentsInput = {
  /** The page's whole live forest; targets are looked up anywhere in it. */
  readonly blocks: readonly BlockNode[];
  /** Block ids to render, in the order the fragments are returned. */
  readonly targets: readonly string[];
  readonly components: ComponentMap;
  /** Label and kind per block type key; a missing type falls back to its key. */
  readonly blockMeta: ReadonlyMap<string, BlockMeta>;
  readonly pageId: string;
  readonly hooks?: RenderHooks;
};

export type RenderedFragment = {
  readonly id: string;
  readonly html: string;
};

export type RenderedFragments = {
  readonly fragments: readonly RenderedFragment[];
  /** Requested ids that are not in the tree; reported, never thrown. */
  readonly missing: readonly string[];
  /** Whether any fragment contained a block that failed or was degraded. */
  readonly degraded: boolean;
};

/** One walk of the forest, keyed by block id. */
function indexById(blocks: readonly BlockNode[]): Map<string, BlockNode> {
  const index = new Map<string, BlockNode>();
  const stack = [...blocks];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    index.set(node.id, node);
    stack.push(...node.children);
  }
  return index;
}

/** Renders the requested blocks of a live tree, one fragment per block. */
export function renderBlockFragments(
  input: RenderBlockFragmentsInput,
): RenderedFragments {
  const index = indexById(input.blocks);
  const editFor = liveEditFor(input.blockMeta);
  const placeholder = placeholderFor(input.blockMeta);
  const fragments: RenderedFragment[] = [];
  const missing: string[] = [];
  let degraded = false;
  for (const id of input.targets) {
    const node = index.get(id);
    if (node === undefined) {
      missing.push(id);
      continue;
    }
    const rendered = renderBlocks([node], {
      components: input.components,
      hooks: input.hooks,
      pageId: input.pageId,
      editFor,
      isDegraded: (candidate) => candidate.degraded,
      placeholderFor: placeholder,
    });
    degraded ||= rendered.degraded;
    fragments.push({ id, html: rendered.body });
  }
  return { fragments, missing, degraded };
}
