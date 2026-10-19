import type { ModelNode } from '../../api-types.js';
import type { TreeModel } from './tree-model.js';

/**
 * Selection over the page model. A click selects the deepest item under the
 * pointer; the scope is the selected item's parent (`null` at the top), kept
 * so the overlay can outline it and the keyboard can walk the siblings, so
 * the pair is `{ parent of selected, selected }` or `{ null, null }`.
 * Everything here reads the model, never the DOM: the caller turns the
 * pointer into a hit chain (the ids of the items under it, innermost first,
 * skipping any element it could not measure) and gets the next selection
 * back. Ancestors are reached by Escape, the breadcrumb and Page structure.
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

/**
 * The deepest item of the chain the model holds: the item a click selects and
 * the hover previews. Ids the model does not know (a site element carrying a
 * stale id) are skipped.
 */
function deepestHit(
  model: TreeModel,
  hitChain: readonly string[],
): ModelNode | null {
  for (const id of hitChain) {
    const node = model.get(id);
    if (node !== undefined) return node;
  }
  return null;
}

/**
 * Click: selects the deepest item under the pointer, whatever is selected
 * now. A click on the item that is already selected keeps it (same object, no
 * toggle); empty page area clears.
 */
export function selectByClick(
  model: TreeModel,
  selection: Selection,
  hitChain: readonly string[],
): Selection {
  const hit = deepestHit(model, hitChain);
  if (hit === null) return NO_SELECTION;
  return hit.id === selection.selectedId ? selection : select(model, hit);
}

/** What a click would select now, for the hover preview. */
export function hoverTarget(
  model: TreeModel,
  hitChain: readonly string[],
): string | null {
  return deepestHit(model, hitChain)?.id ?? null;
}

/** A leaf block has Properties to show; a column has none. */
function leafOpensProperties(node: ModelNode): boolean {
  return node.kind !== 'column';
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
