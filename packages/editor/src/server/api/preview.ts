/**
 * The editor API's live preview (D-24): renders one block's subtree with
 * candidate values, using the same checks a write applies to props and
 * layout, and writes nothing. It takes no lock and bumps no version, so it
 * can run on every pause in typing.
 */
import {
  previewBlockValues,
  type BlockLayout,
  type BlockNode,
} from '@plakboek/pages';
import { renderBlockFragments } from '@plakboek/render/server';
import type { PreviewResponse } from '../../api-types.js';
import { visibleProps } from '../model.js';
import type { PreviewBody } from './schemas.js';
import { notFound, readPageForest, type ApiContext } from './session.js';

function findBlock(
  blocks: readonly BlockNode[],
  blockId: string,
): BlockNode | null {
  const pending = [...blocks];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.id === blockId) return node;
    pending.push(...node.children);
  }
  return null;
}

/** The forest with one node's values replaced; nothing else is copied. */
function withValues(
  blocks: readonly BlockNode[],
  blockId: string,
  values: {
    readonly props: Record<string, unknown>;
    readonly layout: BlockLayout | null;
  },
): readonly BlockNode[] {
  return blocks.map((block) => {
    if (block.id === blockId) return { ...block, ...values };
    return {
      ...block,
      children: withValues(block.children, blockId, values),
    };
  });
}

/** `POST /pages/:id/preview`. A block that is not on this page is 404. */
export async function previewPage(
  context: ApiContext,
  pageId: string,
  body: PreviewBody,
): Promise<PreviewResponse> {
  const { deps } = context;
  const { blocks } = await readPageForest(context, pageId);
  const node = findBlock(blocks, body.blockId);
  if (node === null) throw notFound();

  // The stored props the editor was shown, not the raw row: a key the
  // installation hides is not part of what can be previewed, and the same
  // check a write applies would refuse it as unknown.
  const stored = visibleProps(
    deps.pages.config.blocks.find((block) => block.key === node.blockType),
    node.props,
  );
  const checked = previewBlockValues(deps.pages.config, {
    blockType: node.blockType,
    props: body.props ?? stored,
    layout: body.layout === undefined ? node.layout : body.layout,
  });
  if (!checked.ok) return { ok: false, issues: checked.issues };

  const rendered = renderBlockFragments({
    blocks: withValues(blocks, body.blockId, {
      props: checked.props,
      layout: checked.layout,
    }),
    targets: [body.blockId],
    components: deps.components,
    blockMeta: context.blockMeta,
    pageId,
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
  });
  const fragment = rendered.fragments[0];
  if (fragment === undefined) throw notFound();
  return { ok: true, html: fragment.html, needsInput: checked.missingRequired };
}
