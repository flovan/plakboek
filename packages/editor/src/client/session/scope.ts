import type { ModelNode } from '../../api-types.js';
import type { TreeModel } from './tree-model.js';

/**
 * Scoped selection over the page model. The scope is the container whose
 * children one click can select (`null` is the page); the selected item is
 * always a child of the scope, so the pair is `{ parent of selected,
 * selected }` or `{ null, null }`. Everything here reads the model, never the
 * DOM: the caller turns the pointer into a hit chain (the ids of the items
 * under it, innermost first, skipping any element it could not measure) and
 * gets the next selection back.
 */
export type Selection = {
  readonly scopeId: string | null;
  readonly selectedId: string | null;
};

/** Nothing selected, page scope. */
export const NO_SELECTION: Selection = { scopeId: null, selectedId: null };

/** Whether two selections name the same scope and item. */
export function sameSelection(left: Selection, right: Selection): boolean {
  return left.scopeId === right.scopeId && left.selectedId === right.selectedId;
}

/** What a gesture produced: the next selection and whether to open Properties. */
export type ScopeResult = {
  readonly selection: Selection;
  readonly openProperties: boolean;
};

function select(model: TreeModel, node: ModelNode): Selection {
  return { scopeId: model.parentOf(node.id)?.id ?? null, selectedId: node.id };
}

function ancestorCount(model: TreeModel, id: string): number {
  return model.ancestorsOf(id).length;
}

/**
 * The outermost item of the chain strictly inside `containerId` (anywhere
 * for the page). Outermost is the child of the container unless a level was
 * skipped, in which case the first item below the gap stands in for it.
 */
function outermostInside(
  model: TreeModel,
  hitChain: readonly string[],
  containerId: string | null,
): ModelNode | null {
  let best: ModelNode | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const id of hitChain) {
    const node = model.get(id);
    if (node === undefined) continue;
    if (
      containerId !== null &&
      !model.ancestorsOf(id).some((ancestor) => ancestor.id === containerId)
    ) {
      continue;
    }
    const depth = ancestorCount(model, id);
    if (depth < bestDepth) {
      best = node;
      bestDepth = depth;
    }
  }
  return best;
}

/** What a click would select now: the scope's child under the pointer, climbing as far as the pointer needs. */
function resolveClick(
  model: TreeModel,
  scopeId: string | null,
  hitChain: readonly string[],
): ModelNode | null {
  let container = scopeId;
  for (let steps = 0; steps <= model.size; steps += 1) {
    const hit = outermostInside(model, hitChain, container);
    if (hit !== null) return hit;
    if (container === null) return null;
    container = model.parentOf(container)?.id ?? null;
  }
  return null;
}

/** First click: selects the child of the current scope under the pointer, climbing when the pointer is outside the scope; empty page clears. */
export function selectByClick(
  model: TreeModel,
  selection: Selection,
  hitChain: readonly string[],
): Selection {
  const hit = resolveClick(model, selection.scopeId, hitChain);
  return hit === null ? NO_SELECTION : select(model, hit);
}

/** What a click would select now, for the hover preview. */
export function hoverTarget(
  model: TreeModel,
  selection: Selection,
  hitChain: readonly string[],
): string | null {
  return resolveClick(model, selection.scopeId, hitChain)?.id ?? null;
}

/** A leaf block has Properties to show; a column has none. */
function leafOpensProperties(node: ModelNode): boolean {
  return node.kind !== 'column';
}

function drillInto(
  model: TreeModel,
  node: ModelNode,
  hitChain: readonly string[],
): ScopeResult {
  const children = model.childrenOf(node.id);
  if (children.length === 0) {
    return {
      selection: select(model, node),
      openProperties: leafOpensProperties(node),
    };
  }
  const underPointer = outermostInside(model, hitChain, node.id);
  const only = children[0];
  // A section's single column is selected even with the pointer on the
  // section's own padding.
  const child =
    underPointer ??
    (node.kind === 'section' && children.length === 1 ? only : undefined);
  if (child === undefined) {
    return { selection: select(model, node), openProperties: false };
  }
  return { selection: select(model, child), openProperties: false };
}

/** Double-click: drills one level into the selected item, or asks for Properties on a leaf. */
export function drillByDoubleClick(
  model: TreeModel,
  selection: Selection,
  hitChain: readonly string[],
): ScopeResult {
  const selected =
    selection.selectedId !== null && hitChain.includes(selection.selectedId)
      ? model.get(selection.selectedId)
      : undefined;
  const target =
    selected ?? resolveClick(model, selection.scopeId, hitChain) ?? undefined;
  if (target === undefined) return { selection, openProperties: false };
  return drillInto(model, target, hitChain);
}

/** Escape: selects the parent, and clears at a top-level item. */
export function climb(model: TreeModel, selection: Selection): Selection {
  if (selection.selectedId !== null) {
    const parent = model.parentOf(selection.selectedId);
    return parent === null ? NO_SELECTION : select(model, parent);
  }
  if (selection.scopeId !== null) {
    const scope = model.get(selection.scopeId);
    return scope === undefined ? NO_SELECTION : select(model, scope);
  }
  return selection;
}

/** A breadcrumb crumb: selects that ancestor, and the scope becomes its parent. */
export function selectCrumb(model: TreeModel, id: string): Selection {
  const node = model.get(id);
  return node === undefined ? NO_SELECTION : select(model, node);
}

function siblingsOfSelection(
  model: TreeModel,
  selection: Selection,
): readonly ModelNode[] {
  if (selection.selectedId === null) return model.childrenOf(selection.scopeId);
  const selected = model.get(selection.selectedId);
  return selected === undefined ? [] : model.childrenOf(selected.parentId);
}

function moveAlong(
  model: TreeModel,
  selection: Selection,
  step: 1 | -1,
): Selection {
  const siblings = siblingsOfSelection(model, selection);
  if (siblings.length === 0) return selection;
  if (selection.selectedId === null) {
    const edge = step === 1 ? siblings[0] : siblings[siblings.length - 1];
    return edge === undefined ? selection : select(model, edge);
  }
  const index = siblings.findIndex((node) => node.id === selection.selectedId);
  const next = index === -1 ? undefined : siblings[index + step];
  return next === undefined ? selection : select(model, next);
}

/** Arrow Down: the next sibling in the scope; stays put at the end. */
export function nextSibling(model: TreeModel, selection: Selection): Selection {
  return moveAlong(model, selection, 1);
}

/** Arrow Up: the previous sibling in the scope; stays put at the start. */
export function previousSibling(
  model: TreeModel,
  selection: Selection,
): Selection {
  return moveAlong(model, selection, -1);
}

/** Home. */
export function firstSibling(
  model: TreeModel,
  selection: Selection,
): Selection {
  const first = siblingsOfSelection(model, selection)[0];
  return first === undefined ? selection : select(model, first);
}

/** End. */
export function lastSibling(model: TreeModel, selection: Selection): Selection {
  const siblings = siblingsOfSelection(model, selection);
  const last = siblings[siblings.length - 1];
  return last === undefined ? selection : select(model, last);
}

/** Arrow Right or Enter: the first child, or Properties on a leaf. */
export function drillFirst(
  model: TreeModel,
  selection: Selection,
): ScopeResult {
  if (selection.selectedId === null) {
    const first = model.childrenOf(selection.scopeId)[0];
    return {
      selection: first === undefined ? selection : select(model, first),
      openProperties: false,
    };
  }
  const selected = model.get(selection.selectedId);
  if (selected === undefined) return { selection, openProperties: false };
  const first = model.childrenOf(selected.id)[0];
  if (first === undefined) {
    return { selection, openProperties: leafOpensProperties(selected) };
  }
  return { selection: select(model, first), openProperties: false };
}

/** The path from the outermost ancestor down to the item itself. */
export function breadcrumb(model: TreeModel, id: string): readonly ModelNode[] {
  const node = model.get(id);
  if (node === undefined) return [];
  return [...model.ancestorsOf(id)].reverse().concat(node);
}
