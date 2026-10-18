import type { EditNode, EditPosition } from '../../api-types.js';
import type { Intent } from './save-queue.js';
import type { TreeModel } from './tree-model.js';

/** What an undo or redo names in its toast and tooltip. */
export type ActionLabel = {
  readonly kind: 'added' | 'moved' | 'deleted' | 'duplicated' | 'changed';
  readonly itemId: string;
  readonly property?: string;
};

export type UndoEntry = {
  readonly action: ActionLabel;
  readonly forward: Intent;
  readonly inverse: Intent;
  /** The write needs `pages:delete`, so the UI disables it for a role without it. */
  readonly requiresDelete: boolean;
  /** A field edit is `blockId:propertyKey`; a burst on one key is one entry. */
  readonly coalesceKey: string | null;
  /** An open entry still absorbs further edits to the same key. */
  readonly open: boolean;
};

export type UndoStack = {
  readonly undo: readonly UndoEntry[];
  readonly redo: readonly UndoEntry[];
};

function requireNode(model: TreeModel, id: string) {
  const node = model.get(id);
  if (node === undefined) throw new Error(`Unknown block ${id}`);
  return node;
}

/**
 * The item and everything under it as an insert payload: every node keeps its
 * id, type, properties and layout, children in sort order.
 */
export function captureSubtree(model: TreeModel, id: string): EditNode {
  const node = requireNode(model, id);
  const children = model
    .childrenOf(id)
    .map((child) => captureSubtree(model, child.id));
  return {
    id: node.id,
    type: node.type,
    props: node.props,
    layout: node.layout,
    ...(children.length === 0 ? {} : { children }),
  };
}

/** Where an item sits now: under its parent, between its current neighbours. */
export function positionOf(model: TreeModel, id: string): EditPosition {
  const node = requireNode(model, id);
  const siblings = model.childrenOf(node.parentId);
  const at = siblings.findIndex((sibling) => sibling.id === id);
  return {
    parentId: node.parentId,
    previousId: siblings[at - 1]?.id ?? null,
    nextId: siblings[at + 1]?.id ?? null,
  };
}

function insertedRootId(intent: Extract<Intent, { kind: 'insert' }>): string {
  const id = intent.node.id;
  if (id === undefined) {
    throw new Error('An inserted node must carry the id the caller minted');
  }
  return id;
}

/** Null for a member of a group that names a block the group itself created. */
function invert(
  intent: Intent,
  before: TreeModel,
  insideGroup: boolean,
): Intent | null {
  switch (intent.kind) {
    case 'insert':
      return { kind: 'delete', blockId: insertedRootId(intent) };
    case 'duplicate':
      return { kind: 'delete', blockId: intent.newId };
    case 'delete':
      return {
        kind: 'insert',
        position: positionOf(before, intent.blockId),
        node: captureSubtree(before, intent.blockId),
      };
    case 'move':
      if (insideGroup && before.get(intent.blockId) === undefined) return null;
      return {
        kind: 'move',
        blockId: intent.blockId,
        position: positionOf(before, intent.blockId),
      };
    case 'update': {
      const node = before.get(intent.blockId);
      if (node === undefined) {
        // The group made this block, and undoing the group deletes it.
        if (insideGroup) return null;
        throw new Error(`Unknown block ${intent.blockId}`);
      }
      const props =
        intent.props === undefined
          ? undefined
          : Object.fromEntries(
              Object.keys(intent.props).map((key) => [key, node.props[key]]),
            );
      return {
        kind: 'update',
        blockId: intent.blockId,
        ...(props === undefined ? {} : { props }),
        ...(intent.layout === undefined ? {} : { layout: node.layout }),
      };
    }
    case 'group': {
      const members: Intent[] = [];
      for (const member of intent.intents.toReversed()) {
        const inverse = invert(member, before, true);
        if (inverse !== null) members.push(inverse);
      }
      return { kind: 'group', intents: members };
    }
  }
}

/**
 * The intent that undoes `intent`, built from the model as it is before the
 * intent is applied: a delete comes back as the captured subtree with its
 * original ids at its original position, an insert or duplicate is deleted by
 * id, a move goes back, an update restores the previous value of each key it set.
 */
export function inverseOf(intent: Intent, before: TreeModel): Intent {
  const inverse = invert(intent, before, false);
  if (inverse === null) throw new Error('Nothing to invert');
  return inverse;
}

function containsDelete(intent: Intent): boolean {
  if (intent.kind === 'delete') return true;
  if (intent.kind === 'group') return intent.intents.some(containsDelete);
  return false;
}

/** An undo entry for `forward`, with its inverse taken from the model before it. */
export function buildUndoEntry(
  forward: Intent,
  before: TreeModel,
  action: ActionLabel,
  options: { readonly coalesceKey?: string; readonly open?: boolean } = {},
): UndoEntry {
  const inverse = inverseOf(forward, before);
  return {
    action,
    forward,
    inverse,
    requiresDelete: containsDelete(forward) || containsDelete(inverse),
    coalesceKey: options.coalesceKey ?? null,
    open: options.open ?? false,
  };
}

export function createUndoStack(): UndoStack {
  return { undo: [], redo: [] };
}

/** Empty both stacks: the page reloaded or the lock was lost. */
export function clearUndo(): UndoStack {
  return createUndoStack();
}

function closed(entry: UndoEntry): UndoEntry {
  return entry.open ? { ...entry, open: false } : entry;
}

/**
 * Push an entry and clear redo. When the top entry is open and has the same
 * non-null coalesce key, the new forward replaces the top's and the original
 * inverse stays, so a burst of edits to one field is one undo step.
 */
export function recordUndo(stack: UndoStack, entry: UndoEntry): UndoStack {
  const top = stack.undo.at(-1);
  if (
    top !== undefined &&
    top.open &&
    entry.coalesceKey !== null &&
    top.coalesceKey === entry.coalesceKey
  ) {
    return {
      undo: [...stack.undo.slice(0, -1), { ...top, forward: entry.forward }],
      redo: [],
    };
  }
  // Starting something else ends the burst the previous entry was collecting.
  const rest =
    top === undefined ? [] : [...stack.undo.slice(0, -1), closed(top)];
  return { undo: [...rest, entry], redo: [] };
}

/** The idle save or a blur ended the burst: further edits start a new entry. */
export function closeTop(stack: UndoStack): UndoStack {
  const top = stack.undo.at(-1);
  if (top === undefined || !top.open) return stack;
  return { ...stack, undo: [...stack.undo.slice(0, -1), closed(top)] };
}

/** Undo is a new forward write: the caller enqueues `intent` and records nothing. */
export function takeUndo(
  stack: UndoStack,
): { stack: UndoStack; intent: Intent; entry: UndoEntry } | null {
  const top = stack.undo.at(-1);
  if (top === undefined) return null;
  const entry = closed(top);
  return {
    stack: { undo: stack.undo.slice(0, -1), redo: [...stack.redo, entry] },
    intent: entry.inverse,
    entry,
  };
}

/** Redo re-applies the forward intent, with the same ids. */
export function takeRedo(
  stack: UndoStack,
): { stack: UndoStack; intent: Intent; entry: UndoEntry } | null {
  const top = stack.redo.at(-1);
  if (top === undefined) return null;
  return {
    stack: { undo: [...stack.undo, top], redo: stack.redo.slice(0, -1) },
    intent: top.forward,
    entry: top,
  };
}
