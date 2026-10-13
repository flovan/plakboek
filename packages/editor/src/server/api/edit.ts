/**
 * The editor API's batch edit: one request is one `applyBlockEdit` batch
 * (D-25), answered with the page's new version, the tree as the editor models
 * it and, unless the client asked for none, the rendered fragments to patch
 * into the frame (D-28).
 *
 * The tree is read before and after the write: the planner needs both to
 * find the top level sections that held a touched block on either side of a
 * move.
 */
import {
  applyBlockEdit,
  type BlockEditNode,
  type BlockEditOp,
  type BlockEditPosition,
} from '@plakboek/pages';
import { renderBlockFragments } from '@plakboek/render/server';
import type { EditResponse, FragmentPatch } from '../../api-types.js';
import { toModelNodes } from '../model.js';
import { planFragmentTargets } from './fragments.js';
import type { EditBody, EditBodyOp, EditNodeInput } from './schemas.js';
import { readPageForest, type ApiContext } from './session.js';

type PositionInput = {
  readonly parentId: string | null;
  readonly previousId?: string | null | undefined;
  readonly nextId?: string | null | undefined;
};

function toPosition(position: PositionInput): BlockEditPosition {
  return {
    parentId: position.parentId,
    ...(position.previousId === undefined
      ? {}
      : { previousSiblingId: position.previousId }),
    ...(position.nextId === undefined
      ? {}
      : { nextSiblingId: position.nextId }),
  };
}

function toNode(node: EditNodeInput): BlockEditNode {
  return {
    ...(node.id === undefined ? {} : { id: node.id }),
    type: node.type,
    ...(node.props === undefined ? {} : { props: node.props }),
    ...(node.layout === undefined ? {} : { layout: node.layout }),
    ...(node.children === undefined
      ? {}
      : { children: node.children.map(toNode) }),
  };
}

/** One client op as the engine's op, field for field. */
function toBlockEditOp(op: EditBodyOp): BlockEditOp {
  switch (op.op) {
    case 'insert':
      return {
        op: 'insert',
        position: toPosition(op.position),
        node: toNode(op.node),
      };
    case 'update':
      return {
        op: 'update',
        blockId: op.blockId,
        baseVersion: op.baseVersion,
        ...(op.props === undefined ? {} : { props: op.props }),
        ...(op.layout === undefined ? {} : { layout: op.layout }),
      };
    case 'move':
      return {
        op: 'move',
        blockId: op.blockId,
        baseVersion: op.baseVersion,
        position: toPosition(op.position),
      };
    case 'delete':
      return {
        op: 'delete',
        blockId: op.blockId,
        baseVersion: op.baseVersion,
      };
    case 'duplicate':
      return {
        op: 'duplicate',
        blockId: op.blockId,
        ...(op.newId === undefined ? {} : { newId: op.newId }),
      };
  }
}

/** `POST /pages/:id/edit`. Engine refusals pass through to the caller's
 * error mapping; nothing is written when one is thrown. */
export async function editPage(
  context: ApiContext,
  pageId: string,
  body: EditBody,
): Promise<EditResponse> {
  const { deps, actor } = context;
  const { config } = deps.pages;

  const before = await readPageForest(context, pageId);
  const result = await applyBlockEdit(deps.pages, actor, {
    pageId,
    basePageVersion: body.basePageVersion,
    ops: body.ops.map(toBlockEditOp),
  });
  const after = await readPageForest(context, pageId);

  const beforeModel = toModelNodes(before.blocks, config);
  const afterModel = toModelNodes(after.blocks, config);

  let patch: FragmentPatch | null = null;
  if (body.fragments !== false) {
    const plan = planFragmentTargets({
      before: beforeModel,
      after: afterModel,
      result,
      structural: body.ops.some((op) => op.op !== 'update'),
    });
    // A target the renderer cannot find is left out; the client reloads for
    // a fragment it expected and did not get.
    const rendered = renderBlockFragments({
      blocks: after.blocks,
      targets: plan.targets,
      components: deps.components,
      blockMeta: context.blockMeta,
      pageId,
      ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    });
    patch = {
      fragments: rendered.fragments,
      removed: plan.removed,
      rootOrder: plan.rootOrder,
    };
  }

  return {
    ok: true,
    pageVersion: result.pageVersion,
    tree: afterModel,
    createdIds: result.createdIds,
    deletedIds: result.deletedIds,
    patch,
  };
}
