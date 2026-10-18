import type { EditPosition } from '../../api-types.js';
import { placementRefusal, type LegalityContext } from './legality.js';

export type MoveDirection = 'earlier' | 'later';

/** Why a move control is disabled. */
export type MoveBlockedReason = 'atStart' | 'atEnd';

/** How many nodes each subtree holds, itself included, keyed by id. */
function subtreeSizes(
  order: readonly { readonly id: string; readonly parentId: string | null }[],
): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  const below = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    if (node === undefined) continue;
    const size = 1 + (below.get(node.id) ?? 0);
    sizes.set(node.id, size);
    if (node.parentId !== null) {
      below.set(node.parentId, (below.get(node.parentId) ?? 0) + size);
    }
  }
  return sizes;
}

/**
 * Where an item lands when moved one step earlier or later, or null at the
 * true start or end. Inside its own parent the step passes one sibling. At the
 * end of its parent it crosses into the next (or previous) matching container
 * in document order: a section for a column, a column for a block or a nested
 * section, a container of the same type for an item of a block such as an
 * accordion. Containers placement refuses are skipped. A top-level section
 * only moves among the page's sections.
 */
export function moveTarget(
  ctx: LegalityContext,
  id: string,
  direction: MoveDirection,
): EditPosition | null {
  const { model } = ctx;
  const node = model.get(id);
  if (node === undefined) return null;

  const siblings = model.childrenOf(node.parentId);
  const index = siblings.findIndex((sibling) => sibling.id === id);
  if (index === -1) return null;

  const step = direction === 'later' ? 1 : -1;
  const passed = siblings[index + step];
  if (passed !== undefined) {
    const beyond = siblings[index + 2 * step];
    return direction === 'later'
      ? {
          parentId: node.parentId,
          previousId: passed.id,
          nextId: beyond?.id ?? null,
        }
      : {
          parentId: node.parentId,
          previousId: beyond?.id ?? null,
          nextId: passed.id,
        };
  }

  const parent = node.parentId === null ? null : model.get(node.parentId);
  if (parent === undefined || parent === null) return null;

  const matches = (candidate: {
    readonly kind: string;
    readonly type: string;
  }): boolean =>
    parent.kind === 'block'
      ? candidate.type === parent.type
      : candidate.kind === parent.kind;

  const order = model.documentOrder();
  const sizes = subtreeSizes(order);
  const parentIndex = order.findIndex((entry) => entry.id === parent.id);
  const ancestors = new Set(
    model.ancestorsOf(parent.id).map((ancestor) => ancestor.id),
  );

  let candidates: readonly (typeof order)[number][];
  if (direction === 'later') {
    // Pre-order lists a container before what it holds, so the next sibling
    // container comes before anything nested inside it.
    candidates = order
      .slice(parentIndex + (sizes.get(parent.id) ?? 1))
      .filter(matches);
  } else {
    // The mirror: the container that ends closest before this one starts,
    // outermost first when several end together.
    const ends = new Map<string, number>();
    order.forEach((entry, position) => {
      ends.set(entry.id, position + (sizes.get(entry.id) ?? 1) - 1);
    });
    candidates = order
      .slice(0, parentIndex)
      .filter((entry) => matches(entry) && !ancestors.has(entry.id))
      .toSorted((a, b) => {
        const byEnd = (ends.get(b.id) ?? 0) - (ends.get(a.id) ?? 0);
        return byEnd !== 0 ? byEnd : a.depth - b.depth;
      });
  }

  for (const candidate of candidates) {
    if (
      placementRefusal(ctx, node.type, candidate.id, { movingId: id }) !== null
    ) {
      continue;
    }
    const held = model.childrenOf(candidate.id);
    if (direction === 'later') {
      return {
        parentId: candidate.id,
        previousId: null,
        nextId: held[0]?.id ?? null,
      };
    }
    return {
      parentId: candidate.id,
      previousId: held[held.length - 1]?.id ?? null,
      nextId: null,
    };
  }
  return null;
}

/** For the toolbar: why the control is disabled, or null when the move is possible. */
export function moveTargetReason(
  ctx: LegalityContext,
  id: string,
  direction: MoveDirection,
): MoveBlockedReason | null {
  if (moveTarget(ctx, id, direction) !== null) return null;
  return direction === 'earlier' ? 'atStart' : 'atEnd';
}
