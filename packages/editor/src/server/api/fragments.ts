/**
 * Which parts of the frame an edit makes stale. The frame is patched one top
 * level section at a time (a section's markup depends on its columns and
 * their blocks), except for a batch of property updates, where only the
 * updated blocks are re-rendered.
 */
import type { ModelNode } from '../../api-types.js';

/** The ids a batch touched, as the engine reports them. */
export type TouchedIds = {
  readonly createdIds: readonly string[];
  readonly deletedIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly movedIds: readonly string[];
  /** Old and new parents of the touched blocks; `null` is the page root. */
  readonly touchedParentIds: readonly (string | null)[];
};

export type FragmentPlan = {
  /** Ids to render, in the order the frame should receive them. */
  readonly targets: readonly string[];
  /** Top level sections that are gone. */
  readonly removed: readonly string[];
  /** The top level order after the edit, when it differs from before. */
  readonly rootOrder: readonly string[] | null;
};

/** Each item's top level ancestor (itself for a top level item). */
function topLevelOf(tree: readonly ModelNode[]): Map<string, string> {
  const parents = new Map(tree.map((node) => [node.id, node.parentId]));
  const top = new Map<string, string>();
  for (const node of tree) {
    let current = node.id;
    let parent = parents.get(current) ?? null;
    while (parent !== null) {
      current = parent;
      parent = parents.get(current) ?? null;
    }
    top.set(node.id, current);
  }
  return top;
}

function rootsOf(tree: readonly ModelNode[]): readonly string[] {
  return tree.filter((node) => node.parentId === null).map((node) => node.id);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Plans the patch for an edit from the tree before and after it. A batch of
 * property updates only patches the updated blocks. A structural batch
 * patches every top level section holding a touched block before or after
 * the change, reports the top level sections that vanished and, when the top
 * level sequence changed, the new sequence.
 */
export function planFragmentTargets(input: {
  readonly before: readonly ModelNode[];
  readonly after: readonly ModelNode[];
  readonly result: TouchedIds;
  readonly structural: boolean;
}): FragmentPlan {
  const { before, after, result, structural } = input;
  if (!structural) {
    return { targets: result.updatedIds, removed: [], rootOrder: null };
  }

  const topBefore = topLevelOf(before);
  const topAfter = topLevelOf(after);
  const rootsBefore = rootsOf(before);
  const rootsAfter = rootsOf(after);
  const present = new Set(rootsAfter);

  const touched = new Set<string>([
    ...result.createdIds,
    ...result.deletedIds,
    ...result.movedIds,
    ...result.updatedIds,
  ]);
  for (const parent of result.touchedParentIds) {
    if (parent !== null) touched.add(parent);
  }

  const affected = new Set<string>();
  for (const id of touched) {
    for (const top of [topBefore.get(id), topAfter.get(id)]) {
      if (top !== undefined && present.has(top)) affected.add(top);
    }
  }

  return {
    targets: rootsAfter.filter((id) => affected.has(id)),
    removed: rootsBefore.filter((id) => !present.has(id)),
    rootOrder: sameOrder(rootsBefore, rootsAfter) ? null : rootsAfter,
  };
}
