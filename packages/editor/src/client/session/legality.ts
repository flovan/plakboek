import type { CatalogueEntry } from '../../api-types.js';
import type { TreeModel } from './tree-model.js';

/**
 * Drop-target legality for the editor client. The client cannot import the
 * pages engine, so this mirrors the engine's pure placement decision rule for
 * rule; a parity test holds the two together. The engine still re-checks every
 * write, so a divergence can only ever show a wrong affordance, never write a
 * wrong tree.
 */

/** Why the engine refuses a placement, in the order it checks them. */
export type PlacementReason =
  | 'owner-type'
  | 'section-required'
  | 'parent-rejects-child'
  | 'child-rejects-parent'
  | 'column-requires-section'
  | 'section-requires-columns'
  | 'section-nesting'
  | 'block-depth';

/** Refusals only the client can give: it knows the model, the engine knows the row. */
export type ClientRefusal = 'circular' | 'unknown-type' | 'unknown-parent';

/** The name of the tree's own root in an `allowedParents` list. */
const ROOT_PARENT = '@root';

/** Everything the decision needs, already looked up. */
export type PlacementInput = {
  readonly ownerType: string;
  readonly child: CatalogueEntry;
  readonly parent: CatalogueEntry | null;
  /** The column parent's own section; null when the parent is not a column. */
  readonly section: CatalogueEntry | null;
  readonly parentDepth: number | null;
  readonly parentSectionDepth: number;
  readonly sectionNestingDepth: number;
  readonly blockDepthCeiling: number;
  readonly columnsEnabled: boolean;
};

/** The refusal reason for a placement, or null when it is legal. */
export function decidePlacement(input: PlacementInput): PlacementReason | null {
  const { child, parent } = input;

  if (!child.placement.ownerTypes.includes(input.ownerType)) {
    return 'owner-type';
  }

  if (
    parent === null &&
    input.ownerType === 'page' &&
    child.kind !== 'section'
  ) {
    return 'section-required';
  }

  if (child.kind === 'column') {
    if (parent?.kind !== 'section') return 'column-requires-section';
  } else {
    if (input.columnsEnabled && parent?.kind === 'section') {
      return 'section-requires-columns';
    }

    let effectiveParent: CatalogueEntry | null = parent;
    if (parent?.kind === 'column') {
      if (input.section === null) return 'column-requires-section';
      effectiveParent = input.section;
    }

    if (effectiveParent !== null) {
      const allowedChildren = effectiveParent.placement.allowedChildren;
      const parentAccepts =
        allowedChildren === 'any'
          ? true
          : allowedChildren === 'none'
            ? false
            : allowedChildren.includes(child.key);
      if (!parentAccepts) return 'parent-rejects-child';
    }

    const allowedParents = child.placement.allowedParents;
    const parentKey =
      effectiveParent === null ? ROOT_PARENT : effectiveParent.key;
    const childAccepts =
      allowedParents === 'any' ? true : allowedParents.includes(parentKey);
    if (!childAccepts) return 'child-rejects-parent';
  }

  if (
    child.kind === 'section' &&
    input.parentSectionDepth + 1 > input.sectionNestingDepth
  ) {
    return 'section-nesting';
  }

  if ((input.parentDepth ?? -1) + 1 > input.blockDepthCeiling) {
    return 'block-depth';
  }

  return null;
}

/** What legality reads from the session. */
export type LegalityContext = {
  readonly catalogue: ReadonlyMap<string, CatalogueEntry>;
  readonly model: TreeModel;
  readonly limits: {
    readonly sectionNestingDepth: number;
    readonly blockDepthCeiling: number;
  };
  readonly columnsEnabled: boolean;
  /** Pages are the only owner today. */
  readonly ownerType?: string;
};

export type PlaceOptions = {
  /** Set when an existing item is being moved rather than a new one inserted. */
  readonly movingId?: string;
};

type SubtreeShape = { readonly height: number; readonly sectionHeight: number };

/** The moved subtree's own height and its deepest run of sections, the root included. */
function subtreeShape(ctx: LegalityContext, rootId: string): SubtreeShape {
  let height = 0;
  let sectionHeight = 0;
  const stack: { id: string; relDepth: number; sectionDepth: number }[] = [];
  const enter = (
    id: string,
    relDepth: number,
    parentSections: number,
  ): void => {
    const isSection =
      ctx.catalogue.get(ctx.model.get(id)?.type ?? '')?.kind === 'section';
    stack.push({
      id,
      relDepth,
      sectionDepth: parentSections + (isSection ? 1 : 0),
    });
  };
  enter(rootId, 0, 0);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    height = Math.max(height, current.relDepth);
    sectionHeight = Math.max(sectionHeight, current.sectionDepth);
    for (const child of ctx.model.childrenOf(current.id)) {
      enter(child.id, current.relDepth + 1, current.sectionDepth);
    }
  }
  return { height, sectionHeight };
}

/** The section kind of every ancestor-or-self of the destination, as the registry would count it. */
function sectionsAbove(ctx: LegalityContext, parentId: string): number {
  const path = [
    parentId,
    ...ctx.model.ancestorsOf(parentId).map((node) => node.id),
  ];
  return path.filter(
    (id) =>
      ctx.catalogue.get(ctx.model.get(id)?.type ?? '')?.kind === 'section',
  ).length;
}

/**
 * Why a block of `childType` cannot go under `parentId` (null for the page),
 * or null when it can. With `movingId` set the destination is also refused
 * inside the moved item's own subtree, and the moved subtree's height and
 * section height count the way the engine counts them on a move.
 */
export function placementRefusal(
  ctx: LegalityContext,
  childType: string,
  parentId: string | null,
  options: PlaceOptions = {},
): PlacementReason | ClientRefusal | null {
  const child = ctx.catalogue.get(childType);
  if (child === undefined) return 'unknown-type';

  const movingId = options.movingId;
  if (
    movingId !== undefined &&
    parentId !== null &&
    ctx.model.subtreeIds(movingId).includes(parentId)
  ) {
    return 'circular';
  }

  let parent: CatalogueEntry | null = null;
  let section: CatalogueEntry | null = null;
  let parentDepth: number | null = null;
  let parentSectionDepth = 0;
  if (parentId !== null) {
    const parentNode = ctx.model.get(parentId);
    const parentEntry = ctx.catalogue.get(parentNode?.type ?? '');
    if (parentNode === undefined || parentEntry === undefined) {
      return 'unknown-parent';
    }
    parent = parentEntry;
    parentDepth = parentNode.depth;
    parentSectionDepth = sectionsAbove(ctx, parentId);
    if (parentEntry.kind === 'column') {
      const sectionNode = ctx.model.parentOf(parentId);
      section = ctx.catalogue.get(sectionNode?.type ?? '') ?? null;
    }
  }

  const reason = decidePlacement({
    ownerType: ctx.ownerType ?? 'page',
    child,
    parent,
    section,
    parentDepth,
    parentSectionDepth,
    sectionNestingDepth: ctx.limits.sectionNestingDepth,
    blockDepthCeiling: ctx.limits.blockDepthCeiling,
    columnsEnabled: ctx.columnsEnabled,
  });
  if (reason !== null) return reason;

  if (movingId !== undefined) {
    const shape = subtreeShape(ctx, movingId);
    if ((parentDepth ?? -1) + 1 + shape.height > ctx.limits.blockDepthCeiling) {
      return 'block-depth';
    }
    if (
      parentSectionDepth + shape.sectionHeight >
      ctx.limits.sectionNestingDepth
    ) {
      return 'section-nesting';
    }
  }
  return null;
}

/** Whether a block of `childType` may go under `parentId`. */
export function canPlace(
  ctx: LegalityContext,
  childType: string,
  parentId: string | null,
  options: PlaceOptions = {},
): boolean {
  return placementRefusal(ctx, childType, parentId, options) === null;
}

/** The catalogue keys that may be added under `parentId`, in catalogue order. */
export function legalTypesAt(
  ctx: LegalityContext,
  parentId: string | null,
): readonly string[] {
  const keys: string[] = [];
  for (const key of ctx.catalogue.keys()) {
    if (canPlace(ctx, key, parentId)) keys.push(key);
  }
  return keys;
}
