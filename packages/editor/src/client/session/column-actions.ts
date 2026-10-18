/**
 * Adding, removing, copying and moving a section's columns, and changing its
 * layout, decided apart from the DOM. A section's column count and its ratio
 * belong together: the ratio names one term per column, so every write that
 * changes how many columns a section holds also puts the section back on the
 * equal split for the new count (D-05). That is one group intent, one batch
 * and one undo step, so a half-applied change (a new column beside the old
 * ratio) can never be saved or undone.
 */
import type { EditPosition, ModelLayout } from '../../api-types.js';
import { isEqualRatio } from './presets.js';
import type { Intent } from './save-queue.js';
import type { TreeModel } from './tree-model.js';

/** The type key of the column kind, read from the section's own columns. */
const FALLBACK_COLUMN_TYPE = 'column';

/**
 * A layout in the form the engine stores: an equal ratio, stretch alignment
 * and a fill of false are absent, and a layout with nothing left is null.
 */
export function normalizeLayout(
  layout: ModelLayout | null | undefined,
): ModelLayout | null {
  if (layout === null || layout === undefined) return null;
  const columns =
    layout.columns !== undefined && !isEqualRatio(layout.columns)
      ? layout.columns
      : undefined;
  const align =
    layout.align !== undefined && layout.align !== 'stretch'
      ? layout.align
      : undefined;
  const fill = layout.fill === true ? true : undefined;
  if (columns === undefined && align === undefined && fill === undefined) {
    return null;
  }
  return {
    ...(columns === undefined ? {} : { columns }),
    ...(align === undefined ? {} : { align }),
    ...(fill === undefined ? {} : { fill }),
  };
}

/** The layout a section has once its column count has changed: no ratio, alignment kept. */
function resetColumns(model: TreeModel, sectionId: string): ModelLayout | null {
  const layout = model.get(sectionId)?.layout ?? null;
  return normalizeLayout(
    layout === null ? null : { ...layout, columns: undefined },
  );
}

/** The update that puts a section back on the equal split. */
function resetIntent(model: TreeModel, sectionId: string): Intent {
  return {
    kind: 'update',
    blockId: sectionId,
    layout: resetColumns(model, sectionId),
  };
}

/** Where a column goes under a section: right after `afterColumnId`, else at the end. */
function columnPosition(
  model: TreeModel,
  sectionId: string,
  afterColumnId: string | null,
): EditPosition {
  const columns = model.childrenOf(sectionId);
  const at =
    afterColumnId === null
      ? columns.length - 1
      : columns.findIndex((column) => column.id === afterColumnId);
  return {
    parentId: sectionId,
    previousId: columns[at]?.id ?? null,
    nextId: columns[at + 1]?.id ?? null,
  };
}

/**
 * A new, empty column in a section and the switch to the equal split, as one
 * group. `afterColumnId` names the column it goes after; null puts it last.
 */
export function addColumnIntent(
  model: TreeModel,
  sectionId: string,
  afterColumnId: string | null,
  newId: string,
): Intent {
  const type = model.childrenOf(sectionId)[0]?.type ?? FALLBACK_COLUMN_TYPE;
  return {
    kind: 'group',
    intents: [
      {
        kind: 'insert',
        position: columnPosition(model, sectionId, afterColumnId),
        node: { id: newId, type },
      },
      resetIntent(model, sectionId),
    ],
  };
}

/**
 * Removing a column (its blocks go with it) and the switch to the equal
 * split, as one group. Null for anything but a column, and for a section's
 * only column: a section always keeps one.
 */
export function removeColumnIntent(
  model: TreeModel,
  columnId: string,
): Intent | null {
  const column = model.get(columnId);
  if (column === undefined || column.kind !== 'column') return null;
  const sectionId = column.parentId;
  if (sectionId === null || model.childrenOf(sectionId).length <= 1) {
    return null;
  }
  return {
    kind: 'group',
    intents: [
      { kind: 'delete', blockId: columnId },
      resetIntent(model, sectionId),
    ],
  };
}

/**
 * A copy of a column right after it and the switch to the equal split, as one
 * group. Null for anything but a column.
 */
export function duplicateColumnIntent(
  model: TreeModel,
  columnId: string,
  newId: string,
): Intent | null {
  const column = model.get(columnId);
  if (column === undefined || column.kind !== 'column') return null;
  if (column.parentId === null) return null;
  return {
    kind: 'group',
    intents: [
      { kind: 'duplicate', blockId: columnId, newId },
      resetIntent(model, column.parentId),
    ],
  };
}

/**
 * Moving a column. Within its section only the order changes; into another
 * section it leaves one count and joins another, so both sections go back to
 * the equal split together with the move.
 */
export function moveColumnIntent(
  model: TreeModel,
  columnId: string,
  position: EditPosition,
): Intent {
  const move: Intent = { kind: 'move', blockId: columnId, position };
  const column = model.get(columnId);
  const from = column?.parentId ?? null;
  if (
    column === undefined ||
    column.kind !== 'column' ||
    from === null ||
    position.parentId === null ||
    position.parentId === from
  ) {
    return move;
  }
  return {
    kind: 'group',
    intents: [
      move,
      resetIntent(model, from),
      resetIntent(model, position.parentId),
    ],
  };
}

/**
 * The update that changes some of an item's layout values and leaves the
 * rest. A key named in `change` replaces the item's value (undefined clears
 * it); the result is normalised, so choosing the equal split or stretch
 * stores nothing.
 */
export function layoutIntent(
  model: TreeModel,
  blockId: string,
  change: Partial<ModelLayout>,
): Intent {
  const current = model.get(blockId)?.layout ?? null;
  return {
    kind: 'update',
    blockId,
    layout: normalizeLayout({ ...current, ...change }),
  };
}
