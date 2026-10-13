import type { CatalogueEntry, ModelNode } from '../../api-types.js';

/** What an item is called in the chrome. A column is numbered, so the chrome formats it. */
export type ItemLabel =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'column'; readonly n: number };

/** The page tree as the editor reads it: parent and child lookups over one flat list. */
export type TreeModel = {
  readonly size: number;
  get(id: string): ModelNode | undefined;
  /** The children of an item, or the top-level sections for `null`, in order. */
  childrenOf(id: string | null): readonly ModelNode[];
  parentOf(id: string): ModelNode | null;
  /** The ancestors of an item, nearest first. */
  ancestorsOf(id: string): readonly ModelNode[];
  roots(): readonly ModelNode[];
  /** Every item, depth first, each parent before its children. */
  documentOrder(): readonly ModelNode[];
  /** The item and everything under it, depth first. */
  subtreeIds(id: string): readonly string[];
  /** The zero-based position among siblings, and how many siblings there are. */
  siblingIndex(
    id: string,
  ): { readonly index: number; readonly total: number } | null;
};

function compareNodes(a: ModelNode, b: ModelNode): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Builds the lookups once; a model is never changed, a new payload makes a new model. */
export function createTreeModel(nodes: readonly ModelNode[]): TreeModel {
  const byId = new Map<string, ModelNode>();
  for (const node of nodes) byId.set(node.id, node);

  const children = new Map<string | null, ModelNode[]>();
  for (const node of byId.values()) {
    const list = children.get(node.parentId);
    if (list === undefined) children.set(node.parentId, [node]);
    else list.push(node);
  }
  for (const list of children.values()) list.sort(compareNodes);

  const none: readonly ModelNode[] = [];
  const childrenOf = (id: string | null): readonly ModelNode[] =>
    children.get(id) ?? none;

  const parentOf = (id: string): ModelNode | null => {
    const node = byId.get(id);
    if (node === undefined || node.parentId === null) return null;
    return byId.get(node.parentId) ?? null;
  };

  const ancestorsOf = (id: string): readonly ModelNode[] => {
    const result: ModelNode[] = [];
    let current = parentOf(id);
    // A payload never loops, but a bad one must not hang the editor.
    while (current !== null && result.length < byId.size) {
      result.push(current);
      current = parentOf(current.id);
    }
    return result;
  };

  const walk = (startId: string | null): ModelNode[] => {
    const result: ModelNode[] = [];
    const stack: ModelNode[] = [...childrenOf(startId)].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      result.push(node);
      const below = childrenOf(node.id);
      for (let index = below.length - 1; index >= 0; index -= 1) {
        const child = below[index];
        if (child !== undefined) stack.push(child);
      }
    }
    return result;
  };

  const order = walk(null);

  return {
    size: byId.size,
    get: (id) => byId.get(id),
    childrenOf,
    parentOf,
    ancestorsOf,
    roots: () => childrenOf(null),
    documentOrder: () => order,
    subtreeIds: (id) => {
      if (!byId.has(id)) return [];
      return [id, ...walk(id).map((node) => node.id)];
    },
    siblingIndex: (id) => {
      const node = byId.get(id);
      if (node === undefined) return null;
      const siblings = childrenOf(node.parentId);
      const index = siblings.findIndex((sibling) => sibling.id === id);
      return index === -1 ? null : { index, total: siblings.length };
    },
  };
}

/**
 * The name the chrome shows for an item: the block type's editor label, a
 * numbered column, or the type key when the type is not in the catalogue.
 */
export function labelOf(
  model: TreeModel,
  catalogueByKey: ReadonlyMap<string, CatalogueEntry>,
  id: string,
): ItemLabel {
  const node = model.get(id);
  if (node === undefined) return { kind: 'text', text: id };
  if (node.kind === 'column') {
    const position = model.siblingIndex(id);
    return { kind: 'column', n: (position?.index ?? 0) + 1 };
  }
  const entry = catalogueByKey.get(node.type);
  return { kind: 'text', text: entry?.editor.label ?? node.type };
}
