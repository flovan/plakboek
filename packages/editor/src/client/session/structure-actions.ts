/**
 * What deleting and duplicating an item mean for the page, decided apart from
 * the DOM: how much a delete takes with it, whether it needs the editor's
 * confirmation, where the selection goes afterwards, and whether the item may
 * be deleted or copied at all. The chrome and the keyboard both read these, so
 * a button and a key never disagree.
 */
import { formatString } from '../../chrome/strings.js';
import { buildUndoEntry, type UndoEntry } from './inverse.js';
import { canPlace, type LegalityContext } from './legality.js';
import { catalogueByKey, legalityContextOf } from './move-action.js';
import type { Intent } from './save-queue.js';
import { NO_SELECTION, selectCrumb, type Selection } from './scope.js';
import type { EditorState } from './store.js';
import { labelOf, type TreeModel } from './tree-model.js';

/** How many blocks a delete takes with it besides the item: its non-column descendants. */
export function deleteImpact(model: TreeModel, id: string): number {
  let count = 0;
  for (const descendant of model.subtreeIds(id)) {
    if (descendant === id) continue;
    if (model.get(descendant)?.kind !== 'column') count += 1;
  }
  return count;
}

/** Whether more than the item itself goes, so the editor is asked first. */
export function needsDeleteConfirmation(model: TreeModel, id: string): boolean {
  return deleteImpact(model, id) > 0;
}

/** A section always keeps one column, so its only column cannot go. */
export function isLastColumn(model: TreeModel, id: string): boolean {
  const node = model.get(id);
  if (node === undefined || node.kind !== 'column') return false;
  return model.childrenOf(node.parentId).length === 1;
}

/** The item to select once `id` is gone: the next sibling, else the previous, else the parent. */
export function idAfterDelete(model: TreeModel, id: string): string | null {
  const node = model.get(id);
  if (node === undefined) return null;
  const siblings = model.childrenOf(node.parentId);
  const at = siblings.findIndex((sibling) => sibling.id === id);
  return siblings[at + 1]?.id ?? siblings[at - 1]?.id ?? node.parentId;
}

/** The selection once `id` is gone; nothing when the page is left empty. */
export function selectionAfterDelete(model: TreeModel, id: string): Selection {
  const next = idAfterDelete(model, id);
  return next === null ? NO_SELECTION : selectCrumb(model, next);
}

/**
 * Whether a copy of the item may sit right after it: the same placement rules
 * as for any block of its type under the same parent, with the item's own
 * subtree counted into the depth limits.
 */
export function canDuplicate(ctx: LegalityContext, id: string): boolean {
  const node = ctx.model.get(id);
  if (node === undefined) return false;
  return canPlace(ctx, node.type, node.parentId, { movingId: id });
}

/** Why the item cannot be deleted, as a key of the strings module; null when it can. */
export function deleteBlockedReason(
  state: EditorState,
  id: string,
): 'toolbar.reason.noDeletePermission' | 'toolbar.reason.lastColumn' | null {
  const { model, session } = state;
  if (model === null || session === null) {
    return 'toolbar.reason.noDeletePermission';
  }
  if (!session.canDelete) return 'toolbar.reason.noDeletePermission';
  if (isLastColumn(model, id)) return 'toolbar.reason.lastColumn';
  return null;
}

/** What the chrome calls an item: its editor label, or a numbered column. */
export function itemText(state: EditorState, id: string): string {
  const { model, session } = state;
  if (model === null) return id;
  const label = labelOf(model, catalogueByKey(session?.catalogue ?? []), id);
  return label.kind === 'column'
    ? formatString('label.column', { n: String(label.n) })
    : label.text;
}

export type DeleteAction = {
  readonly intent: Intent;
  readonly entry: UndoEntry;
  /** The item's name, taken before it is gone. */
  readonly label: string;
  /** The item to select afterwards. */
  readonly selectId: string | null;
};

/** The delete of an item with its undo entry; null when the item cannot be deleted. */
export function deleteActionFor(
  state: EditorState,
  id: string,
): DeleteAction | null {
  const { model } = state;
  if (model === null || model.get(id) === undefined) return null;
  if (deleteBlockedReason(state, id) !== null) return null;
  const intent: Intent = { kind: 'delete', blockId: id };
  return {
    intent,
    entry: buildUndoEntry(intent, model, { kind: 'deleted', itemId: id }),
    label: itemText(state, id),
    selectId: idAfterDelete(model, id),
  };
}

/** The copy of an item under `newId`, with its undo entry; null when no legal slot allows it. */
export function duplicateActionFor(
  state: EditorState,
  id: string,
  newId: string,
): { readonly intent: Intent; readonly entry: UndoEntry } | null {
  const ctx = legalityContextOf(state);
  if (ctx === null || !canDuplicate(ctx, id)) return null;
  const intent: Intent = { kind: 'duplicate', blockId: id, newId };
  return {
    intent,
    // Named after the original: the copy is not in the tree until it is saved.
    entry: buildUndoEntry(intent, ctx.model, {
      kind: 'duplicated',
      itemId: id,
    }),
  };
}
