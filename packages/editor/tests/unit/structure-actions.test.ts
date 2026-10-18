import { describe, expect, it } from 'vitest';
import type { EditorSession } from '../../src/api-types.js';
import type { LegalityContext } from '../../src/client/session/legality.js';
import {
  canDuplicate,
  deleteActionFor,
  deleteBlockedReason,
  deleteImpact,
  duplicateActionFor,
  idAfterDelete,
  isLastColumn,
  needsDeleteConfirmation,
  selectionAfterDelete,
} from '../../src/client/session/structure-actions.js';
import {
  initialEditorState,
  type EditorState,
} from '../../src/client/session/store.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import {
  block,
  buildNodes,
  catalogueEntry,
  column,
  section,
  type Spec,
} from './support/model.js';

const entries = [
  catalogueEntry('section', 'section'),
  catalogueEntry('column', 'column'),
  catalogueEntry('text', 'block'),
  catalogueEntry('single', 'block', { allowedParents: ['@root'] }),
];

// A: ca1 [t1, t2 [no children]], ca2 []   B: cb [t3]   C: cc []
const roots: readonly Spec[] = [
  section('A', [
    column('ca1', [block('t1', 'text'), block('t2', 'text')]),
    column('ca2'),
  ]),
  section('B', [column('cb', [block('t3', 'text')])]),
  section('C', [column('cc')]),
];
const model = createTreeModel(buildNodes(roots));

function stateOf(canDelete: boolean): EditorState {
  const session = {
    catalogue: entries,
    limits: { sectionNestingDepth: 2, blockDepthCeiling: 12 },
    columnsEnabled: true,
    canDelete,
  } as unknown as EditorSession;
  return { ...initialEditorState(), session, model, status: 'editing' };
}

const ctx: LegalityContext = {
  catalogue: new Map(entries.map((entry) => [entry.key, entry])),
  model,
  limits: { sectionNestingDepth: 2, blockDepthCeiling: 12 },
  columnsEnabled: true,
};

describe('delete impact and confirmation', () => {
  it('counts the blocks inside, not the columns', () => {
    expect(deleteImpact(model, 'A')).toBe(2);
    expect(deleteImpact(model, 'ca1')).toBe(2);
    expect(deleteImpact(model, 't1')).toBe(0);
  });

  it('asks only when blocks go with the item', () => {
    expect(needsDeleteConfirmation(model, 'A')).toBe(true);
    expect(needsDeleteConfirmation(model, 'ca1')).toBe(true);
    // a leaf block, an empty column and a section of empty columns go at once
    expect(needsDeleteConfirmation(model, 't1')).toBe(false);
    expect(needsDeleteConfirmation(model, 'ca2')).toBe(false);
    expect(needsDeleteConfirmation(model, 'C')).toBe(false);
  });
});

describe('what is selected after a delete', () => {
  it('takes the next sibling, else the previous, else the parent', () => {
    expect(idAfterDelete(model, 't1')).toBe('t2');
    expect(idAfterDelete(model, 't2')).toBe('t1');
    expect(idAfterDelete(model, 't3')).toBe('cb');
    expect(idAfterDelete(model, 'A')).toBe('B');
    expect(idAfterDelete(model, 'C')).toBe('B');
  });

  it('puts the scope on the parent of the item that is selected', () => {
    expect(selectionAfterDelete(model, 't1')).toEqual({
      scopeId: 'ca1',
      selectedId: 't2',
    });
    expect(selectionAfterDelete(model, 't3')).toEqual({
      scopeId: 'B',
      selectedId: 'cb',
    });
  });

  it('selects nothing when the page is left empty', () => {
    const lone = createTreeModel(buildNodes([section('only')]));
    expect(selectionAfterDelete(lone, 'only')).toEqual({
      scopeId: null,
      selectedId: null,
    });
  });
});

describe('last column and permission', () => {
  it('keeps a section its only column', () => {
    expect(isLastColumn(model, 'cb')).toBe(true);
    expect(isLastColumn(model, 'ca1')).toBe(false);
    expect(isLastColumn(model, 't3')).toBe(false);
  });

  it('names why an item cannot be deleted, permission first', () => {
    expect(deleteBlockedReason(stateOf(true), 'cb')).toBe(
      'toolbar.reason.lastColumn',
    );
    expect(deleteBlockedReason(stateOf(true), 'ca1')).toBeNull();
    expect(deleteBlockedReason(stateOf(false), 'cb')).toBe(
      'toolbar.reason.noDeletePermission',
    );
  });
});

describe('the delete action', () => {
  it('captures the subtree so undo restores the same ids in place', () => {
    const action = deleteActionFor(stateOf(true), 'A');
    expect(action?.label).toBe('section');
    expect(action?.selectId).toBe('B');
    expect(action?.entry.requiresDelete).toBe(true);
    expect(action?.entry.inverse).toMatchObject({
      kind: 'insert',
      position: { parentId: null, previousId: null, nextId: 'B' },
      node: {
        id: 'A',
        children: [
          { id: 'ca1', children: [{ id: 't1' }, { id: 't2' }] },
          { id: 'ca2' },
        ],
      },
    });
  });

  it('refuses a delete the role or the section does not allow', () => {
    expect(deleteActionFor(stateOf(false), 't1')).toBeNull();
    expect(deleteActionFor(stateOf(true), 'cb')).toBeNull();
  });
});

describe('duplicate', () => {
  it('allows a copy where the same type may sit', () => {
    expect(canDuplicate(ctx, 't1')).toBe(true);
    expect(canDuplicate(ctx, 'ca1')).toBe(true);
  });

  it('refuses a block its parent rejects a second time', () => {
    const tight = createTreeModel(
      buildNodes([section('S', [column('c', [block('x', 'single')])])]),
    );
    expect(canDuplicate({ ...ctx, model: tight }, 'x')).toBe(false);
  });

  it('is undone by deleting the copy, and is named after the original', () => {
    const action = duplicateActionFor(stateOf(true), 't1', 'copy');
    expect(action?.intent).toEqual({
      kind: 'duplicate',
      blockId: 't1',
      newId: 'copy',
    });
    expect(action?.entry.inverse).toEqual({ kind: 'delete', blockId: 'copy' });
    expect(action?.entry.action).toEqual({ kind: 'duplicated', itemId: 't1' });
  });
});
