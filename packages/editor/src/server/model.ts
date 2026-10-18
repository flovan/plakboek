/**
 * The page tree as the editor reads it: one flat, pre-order list of items
 * that each say what they are, which version they are at, what they hold and
 * what is still missing, so the client can draw handles and "needs input"
 * flags without knowing the engine's tree shapes.
 */
import {
  findMissingRequiredProps,
  resolveBlockProperties,
  type BlockDefinition,
  type BlockNode,
  type PagesConfig,
} from '@plakboek/pages';
import type { ModelLayout, ModelNode } from '../api-types.js';

/**
 * The stored props a block shows the editor: only the keys the block's
 * resolved properties name. A property an installation hides keeps its stored
 * value in the database (seed data, or a constraint added later) but is
 * never sent out, like it is absent from the catalogue. Without a definition
 * there is no telling which keys are hidden, so nothing is sent.
 */
export function visibleProps(
  definition: BlockDefinition | undefined,
  props: unknown,
): Readonly<Record<string, unknown>> {
  if (
    definition === undefined ||
    typeof props !== 'object' ||
    props === null ||
    Array.isArray(props)
  ) {
    return {};
  }
  const resolved = resolveBlockProperties(definition);
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => Object.hasOwn(resolved, key)),
  );
}

function toLayout(layout: BlockNode['layout']): ModelLayout | null {
  if (layout === null) return null;
  return {
    ...(layout.columns !== undefined ? { columns: layout.columns } : {}),
    ...(layout.align !== undefined ? { align: layout.align } : {}),
    ...(layout.fill !== undefined ? { fill: layout.fill } : {}),
  };
}

function flatten(
  blocks: readonly BlockNode[],
  definitions: ReadonlyMap<string, BlockDefinition>,
  into: ModelNode[],
): void {
  for (const block of blocks) {
    const definition = definitions.get(block.blockType);
    const unavailable: ModelNode['unavailable'] =
      definition === undefined ? 'unknown' : block.degraded ? 'degraded' : null;
    into.push({
      id: block.id,
      parentId: block.parentBlockId,
      type: block.blockType,
      kind: definition?.kind ?? 'block',
      sortOrder: block.sortOrder,
      depth: block.depth,
      version: block.version,
      props: visibleProps(definition, block.props),
      layout: toLayout(block.layout),
      needsInput:
        definition === undefined || block.degraded
          ? []
          : findMissingRequiredProps(definition, block.props),
      unavailable,
    });
    flatten(block.children, definitions, into);
  }
}

/** The tree flattened pre-order (each item before its children, siblings in
 * stored order). A block of a type the config no longer declares is a plain
 * `block` marked unavailable, with nothing flagged as missing. */
export function toModelNodes(
  blocks: readonly BlockNode[],
  config: Pick<PagesConfig, 'blocks'>,
): readonly ModelNode[] {
  const definitions = new Map(config.blocks.map((block) => [block.key, block]));
  const nodes: ModelNode[] = [];
  flatten(blocks, definitions, nodes);
  return nodes;
}
