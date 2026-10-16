import type { CatalogueEntry } from '../../api-types.js';
import { formatString } from '../../chrome/strings.js';
import { labelOf, type TreeModel } from './tree-model.js';

/** One visible row of the Page structure: an item of the page, in page order. */
export type TreeRow = {
  readonly id: string;
  readonly parentId: string | null;
  /** 1 for a section, 2 for a column, 3 for a block, and so on down. */
  readonly level: number;
  /** One-based position among its siblings. */
  readonly posInSet: number;
  readonly setSize: number;
  /** What the row says: the item's name for the editor. */
  readonly label: string;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly needsInput: boolean;
};

/**
 * The name of an item in the chrome: the editor label, "Column {n}" for a
 * column, and "{type} (unavailable)" for a block that cannot render because
 * its type is degraded or not known.
 */
export function rowLabel(
  model: TreeModel,
  catalogueByKey: ReadonlyMap<string, CatalogueEntry>,
  id: string,
): string {
  const node = model.get(id);
  const label = labelOf(model, catalogueByKey, id);
  if (label.kind === 'column') {
    return formatString('label.column', { n: String(label.n) });
  }
  const unavailable =
    node !== undefined &&
    (node.unavailable !== null ||
      (node.kind !== 'column' && !catalogueByKey.has(node.type)));
  return unavailable
    ? formatString('overlay.unavailable', { type: label.text })
    : label.text;
}

/**
 * The rows of the page structure in page order. The descendants of an item in
 * `collapsed` are left out, and the item itself reports `expanded: false`.
 */
export function treeRows(
  model: TreeModel,
  catalogueByKey: ReadonlyMap<string, CatalogueEntry>,
  collapsed: ReadonlySet<string>,
): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (parentId: string | null, level: number): void => {
    const siblings = model.childrenOf(parentId);
    siblings.forEach((node, index) => {
      const below = model.childrenOf(node.id);
      const hasChildren = below.length > 0;
      const expanded = hasChildren && !collapsed.has(node.id);
      rows.push({
        id: node.id,
        parentId,
        level,
        posInSet: index + 1,
        setSize: siblings.length,
        label: rowLabel(model, catalogueByKey, node.id),
        hasChildren,
        expanded,
        needsInput: node.needsInput.length > 0,
      });
      if (expanded) visit(node.id, level + 1);
    });
  };
  visit(null, 1);
  return rows;
}

/** The keys a tree row answers to by moving or expanding. */
export type TreeKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'ArrowRight'
  | 'ArrowLeft'
  | 'Home'
  | 'End';

/** What a key does on a row: move focus to another row, or expand or collapse this one. */
export type TreeMove =
  | { readonly action: 'focus'; readonly id: string }
  | { readonly action: 'expand' }
  | { readonly action: 'collapse' };

/**
 * What `key` does with focus on row `from`, over the visible `rows`, or null
 * when it does nothing (the end of the list, a leaf, a top-level row).
 */
export function keyMove(
  rows: readonly TreeRow[],
  from: string,
  key: TreeKey,
): TreeMove | null {
  const at = rows.findIndex((row) => row.id === from);
  const current = rows[at];
  if (current === undefined) return null;
  const focus = (row: TreeRow | undefined): TreeMove | null =>
    row === undefined ? null : { action: 'focus', id: row.id };
  switch (key) {
    case 'ArrowDown':
      return focus(rows[at + 1]);
    case 'ArrowUp':
      return focus(rows[at - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows[rows.length - 1]);
    case 'ArrowRight':
      if (!current.hasChildren) return null;
      // An expanded row's first child is the very next row.
      return current.expanded ? focus(rows[at + 1]) : { action: 'expand' };
    case 'ArrowLeft':
      if (current.expanded) return { action: 'collapse' };
      return focus(rows.find((row) => row.id === current.parentId));
  }
}
