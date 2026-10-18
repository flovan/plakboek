import { describe, expect, it } from 'vitest';
import type { ModelNode } from '../../src/api-types.js';
import {
  buildUndoEntry,
  captureSubtree,
  clearUndo,
  closeTop,
  createUndoStack,
  inverseOf,
  positionOf,
  recordUndo,
  takeRedo,
  takeUndo,
  type ActionLabel,
} from '../../src/client/session/inverse.js';
import type { Intent } from '../../src/client/session/save-queue.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

function withValues(
  nodes: readonly ModelNode[],
  values: Readonly<
    Record<string, Partial<Pick<ModelNode, 'props' | 'layout'>>>
  >,
) {
  return createTreeModel(
    nodes.map((node) => ({ ...node, ...values[node.id] })),
  );
}

const model = withValues(
  buildNodes([
    section('s0'),
    section('s1', [column('c1', [block('t1', 'text'), block('t2', 'text')])]),
    section('s2'),
    section('s3', [block('a', 'text'), block('b', 'text'), block('c', 'text')]),
  ]),
  {
    s1: { layout: { columns: '1:1', align: 'center' } },
    c1: { layout: { fill: true } },
    t1: { props: { text: 'one' } },
    t2: { props: { text: 'two', tone: 'quiet' } },
    a: { props: { text: 'before' }, layout: { fill: true } },
  },
);

const changed = (itemId: string, property?: string): ActionLabel => ({
  kind: 'changed',
  itemId,
  ...(property === undefined ? {} : { property }),
});

describe('captureSubtree and positionOf', () => {
  it('captures every node with id, props, layout and ordered children', () => {
    expect(captureSubtree(model, 's1')).toEqual({
      id: 's1',
      type: 'section',
      props: {},
      layout: { columns: '1:1', align: 'center' },
      children: [
        {
          id: 'c1',
          type: 'column',
          props: {},
          layout: { fill: true },
          children: [
            { id: 't1', type: 'text', props: { text: 'one' }, layout: null },
            {
              id: 't2',
              type: 'text',
              props: { text: 'two', tone: 'quiet' },
              layout: null,
            },
          ],
        },
      ],
    });
  });

  it('reads the current neighbours', () => {
    expect(positionOf(model, 's1')).toEqual({
      parentId: null,
      previousId: 's0',
      nextId: 's2',
    });
    expect(positionOf(model, 'a')).toEqual({
      parentId: 's3',
      previousId: null,
      nextId: 'b',
    });
  });
});

describe('inverseOf', () => {
  it('re-inserts a deleted section with its original ids at its original position', () => {
    const inverse = inverseOf({ kind: 'delete', blockId: 's1' }, model);
    expect(inverse).toEqual({
      kind: 'insert',
      position: { parentId: null, previousId: 's0', nextId: 's2' },
      node: captureSubtree(model, 's1'),
    });
    if (inverse.kind !== 'insert') throw new Error('expected an insert');
    const ids: string[] = [];
    const collect = (node: typeof inverse.node): void => {
      ids.push(node.id ?? '');
      node.children?.forEach(collect);
    };
    collect(inverse.node);
    expect(ids).toEqual(['s1', 'c1', 't1', 't2']);
  });

  it('deletes an inserted or duplicated block by id', () => {
    expect(
      inverseOf(
        {
          kind: 'insert',
          position: { parentId: 's3' },
          node: { id: 'new', type: 'text' },
        },
        model,
      ),
    ).toEqual({ kind: 'delete', blockId: 'new' });
    expect(
      inverseOf({ kind: 'duplicate', blockId: 'a', newId: 'copy' }, model),
    ).toEqual({ kind: 'delete', blockId: 'copy' });
  });

  it('moves a block back to where it was', () => {
    expect(
      inverseOf(
        {
          kind: 'move',
          blockId: 'a',
          position: { parentId: 's3', previousId: 'c' },
        },
        model,
      ),
    ).toEqual({
      kind: 'move',
      blockId: 'a',
      position: { parentId: 's3', previousId: null, nextId: 'b' },
    });
  });

  it('restores the previous value of exactly the keys an update set', () => {
    expect(
      inverseOf(
        {
          kind: 'update',
          blockId: 'a',
          props: { text: 'after', fresh: 1 },
        },
        model,
      ),
    ).toEqual({
      kind: 'update',
      blockId: 'a',
      props: { text: 'before', fresh: undefined },
    });
    expect(
      inverseOf({ kind: 'update', blockId: 'a', layout: null }, model),
    ).toEqual({ kind: 'update', blockId: 'a', layout: { fill: true } });
  });

  it('inverts a group in reverse order and skips what the group created', () => {
    const group: Intent = {
      kind: 'group',
      intents: [
        {
          kind: 'insert',
          position: { parentId: 's3', previousId: 'c' },
          node: { id: 'col', type: 'column' },
        },
        { kind: 'update', blockId: 'col', props: { gap: 1 } },
        { kind: 'update', blockId: 'a', layout: null },
      ],
    };
    expect(inverseOf(group, model)).toEqual({
      kind: 'group',
      intents: [
        { kind: 'update', blockId: 'a', layout: { fill: true } },
        { kind: 'delete', blockId: 'col' },
      ],
    });
  });
});

describe('buildUndoEntry', () => {
  it('flags an entry whose forward or inverse deletes', () => {
    const insert = buildUndoEntry(
      {
        kind: 'insert',
        position: { parentId: 's3' },
        node: { id: 'new', type: 'text' },
      },
      model,
      { kind: 'added', itemId: 'new' },
    );
    const duplicate = buildUndoEntry(
      { kind: 'duplicate', blockId: 'a', newId: 'copy' },
      model,
      { kind: 'duplicated', itemId: 'copy' },
    );
    const remove = buildUndoEntry({ kind: 'delete', blockId: 'a' }, model, {
      kind: 'deleted',
      itemId: 'a',
    });
    const group = buildUndoEntry(
      {
        kind: 'group',
        intents: [
          { kind: 'delete', blockId: 'b' },
          { kind: 'update', blockId: 'a', layout: null },
        ],
      },
      model,
      { kind: 'deleted', itemId: 'b' },
    );
    expect(
      [insert, duplicate, remove, group].map((e) => e.requiresDelete),
    ).toEqual([true, true, true, true]);
    const plain = [
      buildUndoEntry(
        { kind: 'update', blockId: 'a', props: { text: 'x' } },
        model,
        changed('a', 'text'),
      ),
      buildUndoEntry(
        {
          kind: 'move',
          blockId: 'a',
          position: { parentId: 's3', previousId: 'c' },
        },
        model,
        { kind: 'moved', itemId: 'a' },
      ),
    ];
    expect(plain.map((entry) => entry.requiresDelete)).toEqual([false, false]);
  });
});

describe('undo stack', () => {
  const edit = (value: string) =>
    buildUndoEntry(
      { kind: 'update', blockId: 'a', props: { text: value } },
      model,
      changed('a', 'text'),
      { coalesceKey: 'a:text', open: true },
    );

  it('keeps a burst of edits to one field as one entry with the original inverse', () => {
    let stack = recordUndo(createUndoStack(), edit('A'));
    stack = recordUndo(stack, edit('AB'));
    stack = recordUndo(stack, edit('ABC'));
    expect(stack.undo).toHaveLength(1);
    expect(stack.undo[0]?.forward).toEqual({
      kind: 'update',
      blockId: 'a',
      props: { text: 'ABC' },
    });
    expect(stack.undo[0]?.inverse).toEqual({
      kind: 'update',
      blockId: 'a',
      props: { text: 'before' },
    });
  });

  it('opens a new entry once the burst is closed', () => {
    let stack = recordUndo(createUndoStack(), edit('A'));
    stack = closeTop(stack);
    expect(stack.undo[0]?.open).toBe(false);
    stack = recordUndo(stack, edit('AB'));
    expect(stack.undo).toHaveLength(2);
  });

  it('does not merge a different field or a structural action into a burst', () => {
    let stack = recordUndo(createUndoStack(), edit('A'));
    stack = recordUndo(
      stack,
      buildUndoEntry({ kind: 'delete', blockId: 'b' }, model, {
        kind: 'deleted',
        itemId: 'b',
      }),
    );
    expect(stack.undo).toHaveLength(2);
    expect(stack.undo[0]?.open).toBe(false);
  });

  it('turns undo into the inverse and redo back into the same forward', () => {
    const remove = buildUndoEntry({ kind: 'delete', blockId: 's1' }, model, {
      kind: 'deleted',
      itemId: 's1',
    });
    const stack = recordUndo(createUndoStack(), remove);
    const undone = takeUndo(stack);
    expect(undone?.intent).toEqual(remove.inverse);
    expect(undone?.stack.undo).toHaveLength(0);
    expect(undone?.stack.redo).toHaveLength(1);

    const redone = undone === null ? null : takeRedo(undone.stack);
    expect(redone?.intent).toEqual({ kind: 'delete', blockId: 's1' });
    expect(redone?.stack.undo).toEqual([remove]);
    expect(redone?.stack.redo).toHaveLength(0);

    // Undoing again restores the very same ids.
    const again = redone === null ? null : takeUndo(redone.stack);
    expect(again?.intent).toEqual(remove.inverse);
  });

  it('clears redo on a new action and empties both stacks on clearUndo', () => {
    const stack = recordUndo(createUndoStack(), edit('A'));
    const undone = takeUndo(stack);
    expect(undone?.stack.redo).toHaveLength(1);
    const next = recordUndo(undone?.stack ?? stack, edit('B'));
    expect(next.redo).toHaveLength(0);
    expect(clearUndo()).toEqual({ undo: [], redo: [] });
    expect(takeUndo(createUndoStack())).toBeNull();
    expect(takeRedo(createUndoStack())).toBeNull();
  });
});
