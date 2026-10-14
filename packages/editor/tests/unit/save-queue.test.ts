import { describe, expect, it } from 'vitest';
import type { ModelNode } from '../../src/api-types.js';
import {
  createQueue,
  discardPending,
  dropHead,
  enqueue,
  hasPending,
  markReady,
  onFailure,
  onSuccess,
  pruneEmpty,
  reconcileAfterStale,
  resolvePosition,
  retry,
  takeNext,
  type Intent,
  type QueueEntry,
  type QueueState,
} from '../../src/client/session/save-queue.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, section } from './support/model.js';

function modelOf(
  nodes: readonly ModelNode[],
  patch: Readonly<
    Record<string, Partial<Pick<ModelNode, 'version' | 'props' | 'layout'>>>
  > = {},
) {
  return createTreeModel(nodes.map((node) => ({ ...node, ...patch[node.id] })));
}

const nodes = buildNodes([
  section('s1', [
    block('a', 'text'),
    block('b', 'text'),
    block('h', 'heading'),
    block('c', 'text'),
  ]),
  section('s2'),
]);

function entryOf(intent: Intent): QueueEntry {
  return { seq: 1, intent, ready: true, fragments: false };
}

function sendNext(state: QueueState, model = modelOf(nodes), page = 1) {
  const taken = takeNext(state, model, page);
  if (taken === null) throw new Error('nothing to send');
  return taken;
}

describe('save queue ordering and send-time versions', () => {
  it('turns a move, two quick edits and a delete into three ordered requests', () => {
    let state = createQueue();
    state = enqueue(
      state,
      {
        kind: 'move',
        blockId: 'b',
        position: { parentId: 's1', previousId: 'c' },
      },
      { immediate: true },
    );
    state = enqueue(
      state,
      { kind: 'update', blockId: 'h', props: { text: 'A' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      { kind: 'update', blockId: 'h', props: { text: 'AB' } },
      { immediate: false },
    );
    expect(state.entries).toHaveLength(2);
    state = enqueue(
      state,
      { kind: 'delete', blockId: 'c' },
      { immediate: true },
    );
    expect(state.entries.map((entry) => entry.intent.kind)).toEqual([
      'move',
      'update',
      'delete',
    ]);

    const first = sendNext(state, modelOf(nodes), 4);
    expect(first.request).toEqual({
      basePageVersion: 4,
      ops: [
        {
          op: 'move',
          blockId: 'b',
          baseVersion: 1,
          position: { parentId: 's1', previousId: 'c' },
        },
      ],
    });
    // Nothing leaves while a request is in flight.
    expect(takeNext(first.state, modelOf(nodes), 4)).toBeNull();

    // The first response bumped the page and the moved block; the heading is
    // read at version 3 when the second request is built.
    const afterFirst = modelOf(nodes, {
      b: { version: 2 },
      h: { version: 3 },
    });
    const second = sendNext(onSuccess(first.state), afterFirst, 5);
    expect(second.request).toEqual({
      basePageVersion: 5,
      ops: [
        {
          op: 'update',
          blockId: 'h',
          baseVersion: 3,
          props: { text: 'AB' },
        },
      ],
    });

    const afterSecond = modelOf(nodes, {
      b: { version: 2 },
      h: { version: 4 },
      c: { version: 7 },
    });
    const third = sendNext(onSuccess(second.state), afterSecond, 6);
    expect(third.request.ops).toEqual([
      { op: 'delete', blockId: 'c', baseVersion: 7 },
    ]);
    const done = onSuccess(third.state);
    expect(hasPending(done)).toBe(false);
    expect(done.status).toBe('saved');
  });

  it('keeps an idle property edit back until it is marked ready', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 'h', props: { text: 'x' } },
      { immediate: false },
    );
    expect(takeNext(state, modelOf(nodes), 1)).toBeNull();
    expect(state.status).toBe('saving');
    state = markReady(state, 'h');
    expect(takeNext(state, modelOf(nodes), 1)?.request.ops).toHaveLength(1);
  });

  it('readies every property edit queued before the marked block', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 'a', props: { text: '1' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      { kind: 'update', blockId: 'h', props: { text: '2' } },
      { immediate: false },
    );
    state = markReady(state, 'h');
    expect(state.entries.map((entry) => entry.ready)).toEqual([true, true]);
  });

  it('flushes a pending property edit ahead of a structural intent', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 'h', props: { text: 'x' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      { kind: 'delete', blockId: 'c' },
      { immediate: true },
    );
    expect(state.entries.every((entry) => entry.ready)).toBe(true);
    expect(sendNext(state).request.ops[0]?.op).toBe('update');
  });

  it('puts changed keys on top of the properties the block holds now', () => {
    const model = modelOf(nodes, {
      h: { props: { text: 'old', level: 2 } },
    });
    const state = enqueue(
      createQueue(),
      {
        kind: 'update',
        blockId: 'h',
        props: { text: 'new', level: undefined },
      },
      { immediate: true },
    );
    expect(sendNext(state, model).request.ops[0]).toMatchObject({
      props: { text: 'new' },
    });
  });

  it('merges a layout change with a property change on the same block', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 's1', layout: { columns: '1:2' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      { kind: 'update', blockId: 's1', props: { gap: 'wide' } },
      { immediate: false },
    );
    expect(state.entries[0]?.intent).toEqual({
      kind: 'update',
      blockId: 's1',
      props: { gap: 'wide' },
      layout: { columns: '1:2' },
    });
  });

  it('queues an edit behind a structural write that touches the same block instead of merging ahead of it', () => {
    const restored: Intent = {
      kind: 'insert',
      position: { parentId: 's1', previousId: 'a' },
      node: { id: 'h', type: 'heading', props: { text: 'old' } },
    };
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 'h', props: { text: 'first' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      { kind: 'delete', blockId: 'h' },
      { immediate: true },
    );
    state = enqueue(state, restored, { immediate: true });
    state = enqueue(
      state,
      { kind: 'update', blockId: 'h', props: { text: 'later' } },
      { immediate: false },
    );
    expect(state.entries.map((entry) => entry.intent.kind)).toEqual([
      'update',
      'delete',
      'insert',
      'update',
    ]);
    expect(state.entries[0]?.intent).toEqual({
      kind: 'update',
      blockId: 'h',
      props: { text: 'first' },
    });
    expect(state.entries[3]?.intent).toEqual({
      kind: 'update',
      blockId: 'h',
      props: { text: 'later' },
    });
  });

  it('keeps an undo of a typed change behind a move made after it', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 'h', props: { text: 'typed' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      {
        kind: 'move',
        blockId: 'h',
        position: { parentId: 's1', previousId: null, nextId: 'a' },
      },
      { immediate: true },
    );
    state = enqueue(
      state,
      { kind: 'update', blockId: 'h', props: { text: 'undone' } },
      { immediate: true, fragments: true },
    );
    expect(state.entries.map((entry) => entry.intent.kind)).toEqual([
      'update',
      'move',
      'update',
    ]);
  });

  it('still merges into the latest update when only other blocks were queued after it', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'update', blockId: 'h', props: { text: '1' } },
      { immediate: false },
    );
    state = enqueue(
      state,
      { kind: 'delete', blockId: 'c' },
      { immediate: true },
    );
    state = enqueue(
      state,
      { kind: 'update', blockId: 'h', props: { text: '2' } },
      { immediate: false },
    );
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]?.intent).toEqual({
      kind: 'update',
      blockId: 'h',
      props: { text: '2' },
    });
  });

  it('flattens a group into one request in order and skips vanished blocks', () => {
    const state = enqueue(
      createQueue(),
      {
        kind: 'group',
        intents: [
          {
            kind: 'insert',
            position: { parentId: 's1', previousId: 'a' },
            node: { id: 'n1', type: 'text', props: { text: 'hi' } },
          },
          { kind: 'update', blockId: 'n1', props: { extra: 1 } },
          { kind: 'update', blockId: 'gone', props: { text: 'x' } },
          { kind: 'delete', blockId: 'gone' },
        ],
      },
      { immediate: true, fragments: true },
    );
    const { request } = sendNext(state);
    expect(request.fragments).toBe(true);
    expect(request.ops).toEqual([
      {
        op: 'insert',
        position: { parentId: 's1', previousId: 'a' },
        node: { id: 'n1', type: 'text', props: { text: 'hi' } },
      },
      {
        op: 'update',
        blockId: 'n1',
        baseVersion: 1,
        props: { text: 'hi', extra: 1 },
      },
    ]);
  });

  it('drops an entry whose blocks are all gone and sends the next one', () => {
    let state = enqueue(
      createQueue(),
      { kind: 'delete', blockId: 'gone' },
      { immediate: true },
    );
    state = enqueue(
      state,
      { kind: 'delete', blockId: 'c' },
      { immediate: true },
    );
    const taken = sendNext(state);
    expect(taken.request.ops).toEqual([
      { op: 'delete', blockId: 'c', baseVersion: 1 },
    ]);
    expect(taken.state.entries).toHaveLength(0);

    const onlyGone = enqueue(
      createQueue(),
      { kind: 'delete', blockId: 'gone' },
      { immediate: true },
    );
    expect(takeNext(onlyGone, modelOf(nodes), 1)).toBeNull();
    const pruned = pruneEmpty(onlyGone, modelOf(nodes));
    expect(hasPending(pruned)).toBe(false);
    expect(pruned.status).toBe('saved');
  });
});

describe('save queue failures', () => {
  const pending = (): QueueState =>
    enqueue(
      createQueue(),
      { kind: 'delete', blockId: 'c' },
      { immediate: true },
    );

  it('holds a network failure for Retry and resends the same entry', () => {
    const sent = sendNext(pending());
    const failed = onFailure(sent.state, 'network');
    expect(failed.status).toBe('failed');
    expect(failed.lastFailure).toBe('network');
    expect(failed.entries).toHaveLength(1);
    expect(hasPending(failed)).toBe(true);
    // A later structural action does not push the held write out on its own.
    const later = enqueue(
      failed,
      { kind: 'delete', blockId: 'a' },
      { immediate: true },
    );
    expect(takeNext(later, modelOf(nodes), 1)).toBeNull();
    const resent = sendNext(retry(later));
    expect(resent.entry.intent).toEqual({ kind: 'delete', blockId: 'c' });
    expect(resent.state.status).toBe('saving');
  });

  it('pauses on stale, locked and session failures and keeps the intents', () => {
    for (const kind of ['stale', 'locked', 'session'] as const) {
      const sent = sendNext(pending());
      const queued = enqueue(
        sent.state,
        { kind: 'delete', blockId: 'a' },
        { immediate: true },
      );
      const paused = onFailure(queued, kind);
      expect(paused.status).toBe('paused');
      expect(paused.pauseReason).toBe(kind);
      expect(paused.entries.map((entry) => entry.intent)).toEqual([
        { kind: 'delete', blockId: 'c' },
        { kind: 'delete', blockId: 'a' },
      ]);
      expect(takeNext(paused, modelOf(nodes), 1)).toBeNull();
      expect(paused.entries.every((entry) => entry.ready)).toBe(true);
    }
  });

  it('resumes a pause on retry and sends against the refreshed model', () => {
    const paused = onFailure(sendNext(pending()).state, 'stale');
    const refreshed = modelOf(nodes, { c: { version: 9 } });
    const resumed = sendNext(retry(paused), refreshed, 8);
    expect(resumed.request).toEqual({
      basePageVersion: 8,
      ops: [{ op: 'delete', blockId: 'c', baseVersion: 9 }],
    });
  });

  it('drops a refused write without a retry and carries on', () => {
    let state = enqueue(
      pending(),
      { kind: 'delete', blockId: 'a' },
      { immediate: true },
    );
    const refused = onFailure(sendNext(state).state, 'refused');
    expect(refused.status).toBe('failed');
    expect(refused.lastFailure).toBe('refused');
    expect(refused.entries).toHaveLength(1);
    expect(retry(refused)).toBe(refused);
    state = refused;
    const next = sendNext(state);
    expect(next.entry.intent).toEqual({ kind: 'delete', blockId: 'a' });
    expect(next.state.lastFailure).toBeNull();
  });

  it('starts saving again when a refused write is followed by a new edit', () => {
    const refused = onFailure(sendNext(pending()).state, 'refused');
    const next = enqueue(
      refused,
      { kind: 'update', blockId: 'h', props: { text: 'x' } },
      { immediate: false },
    );
    expect(next.status).toBe('saving');
    expect(next.lastFailure).toBeNull();
  });

  it('drops the head as saved or discards everything on request', () => {
    const paused = onFailure(sendNext(pending()).state, 'stale');
    expect(hasPending(dropHead(paused))).toBe(false);
    expect(dropHead(paused).status).toBe('saved');
    expect(hasPending(discardPending(paused))).toBe(false);
  });
});

describe('resolvePosition', () => {
  const model = modelOf(nodes);

  it('keeps neighbours that are still siblings', () => {
    expect(
      resolvePosition(model, { parentId: 's1', previousId: 'a', nextId: 'b' }),
    ).toEqual({ parentId: 's1', previousId: 'a', nextId: 'b' });
  });

  it('drops a vanished neighbour and keeps the other', () => {
    expect(
      resolvePosition(model, {
        parentId: 's1',
        previousId: 'gone',
        nextId: 'b',
      }),
    ).toEqual({ parentId: 's1', nextId: 'b' });
  });

  it('puts the item first when every named neighbour is gone', () => {
    expect(
      resolvePosition(model, { parentId: 's1', previousId: 'gone' }),
    ).toEqual({ parentId: 's1', nextId: 'a' });
    expect(
      resolvePosition(model, { parentId: 's2', previousId: 'gone' }),
    ).toEqual({ parentId: 's2' });
  });

  it('treats an unnamed position as the end of the list', () => {
    expect(resolvePosition(model, { parentId: 's1' })).toEqual({
      parentId: 's1',
    });
  });

  it('never names the moved block as its own neighbour', () => {
    expect(
      resolvePosition(
        model,
        { parentId: 's1', previousId: 'b', nextId: 'c' },
        new Set<string>(),
        'b',
      ),
    ).toEqual({ parentId: 's1', nextId: 'c' });
  });
});

describe('reconcileAfterStale', () => {
  const fresh = modelOf(nodes, {
    h: { props: { text: 'AB', level: 2 }, layout: { fill: true } },
  });

  it('recognises an update whose values are already there', () => {
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'update', blockId: 'h', props: { text: 'AB' } }),
        fresh,
      ),
    ).toBe('already-applied');
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'update',
          blockId: 'h',
          props: { text: 'AB' },
          layout: { fill: true },
        }),
        fresh,
      ),
    ).toBe('already-applied');
  });

  it('treats a different value or a missing block as a conflict', () => {
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'update', blockId: 'h', props: { text: 'other' } }),
        fresh,
      ),
    ).toBe('conflict');
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'update', blockId: 'h', layout: null }),
        fresh,
      ),
    ).toBe('conflict');
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'update', blockId: 'gone', props: { text: 'AB' } }),
        fresh,
      ),
    ).toBe('conflict');
  });

  it('recognises inserts and duplicates by their ids', () => {
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'insert',
          position: { parentId: 's1' },
          node: {
            id: 'a',
            type: 'text',
            children: [{ id: 'b', type: 'text' }],
          },
        }),
        fresh,
      ),
    ).toBe('already-applied');
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'insert',
          position: { parentId: 's1' },
          node: { id: 'new', type: 'text' },
        }),
        fresh,
      ),
    ).toBe('conflict');
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'duplicate', blockId: 'a', newId: 'c' }),
        fresh,
      ),
    ).toBe('already-applied');
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'duplicate', blockId: 'a', newId: 'copy' }),
        fresh,
      ),
    ).toBe('conflict');
  });

  it('recognises a delete by the block being absent', () => {
    expect(
      reconcileAfterStale(entryOf({ kind: 'delete', blockId: 'gone' }), fresh),
    ).toBe('already-applied');
    expect(
      reconcileAfterStale(entryOf({ kind: 'delete', blockId: 'a' }), fresh),
    ).toBe('conflict');
  });

  it('recognises a move by parent and neighbours', () => {
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'move',
          blockId: 'b',
          position: { parentId: 's1', previousId: 'a', nextId: 'h' },
        }),
        fresh,
      ),
    ).toBe('already-applied');
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'move',
          blockId: 'b',
          position: { parentId: 's1', previousId: 'c' },
        }),
        fresh,
      ),
    ).toBe('conflict');
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'move', blockId: 'b', position: { parentId: 's2' } }),
        fresh,
      ),
    ).toBe('conflict');
    expect(
      reconcileAfterStale(
        entryOf({ kind: 'move', blockId: 'c', position: { parentId: 's1' } }),
        fresh,
      ),
    ).toBe('already-applied');
  });

  it('needs every member of a group to be applied', () => {
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'group',
          intents: [
            { kind: 'delete', blockId: 'gone' },
            { kind: 'update', blockId: 'h', props: { text: 'AB' } },
          ],
        }),
        fresh,
      ),
    ).toBe('already-applied');
    expect(
      reconcileAfterStale(
        entryOf({
          kind: 'group',
          intents: [
            { kind: 'delete', blockId: 'gone' },
            { kind: 'delete', blockId: 'a' },
          ],
        }),
        fresh,
      ),
    ).toBe('conflict');
  });
});
