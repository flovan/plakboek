import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EditRequest,
  EditResponse,
  EditorSession,
  LockView,
  ModelNode,
} from '../../src/api-types.js';
import {
  ApiRequestError,
  type ApiClient,
} from '../../src/client/session/api-client.js';
import { buildUndoEntry } from '../../src/client/session/inverse.js';
import {
  createSaveRunner,
  selectionAfterWrite,
} from '../../src/client/session/save-runner.js';
import type { Intent } from '../../src/client/session/save-queue.js';
import { createEditorStore } from '../../src/client/session/store.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

const MINE: LockView = {
  enabled: true,
  state: 'mine',
  holder: null,
  canTakeOver: false,
  expiresAt: null,
};

const tree = buildNodes([
  section('s1', [
    column('c1', [block('h1', 'heading'), block('h2', 'heading')]),
  ]),
  section('s2', [column('c2', [block('h3', 'heading')])]),
]);

function session(): EditorSession {
  return {
    pageId: 'p1',
    locale: 'en',
    pageVersion: 5,
    canDelete: true,
    columnsEnabled: true,
    lock: MINE,
    catalogue: [],
    columnPresets: [],
    limits: {
      sectionNestingDepth: 2,
      blockDepthCeiling: 6,
      maxOps: 50,
      maxNodes: 500,
      heartbeatSeconds: 30,
      lockTtlSeconds: 90,
    },
    tree,
    upgraded: false,
  };
}

/** The tree after `id` moved to the top of `parentId`'s children, versions bumped. */
function movedToTop(
  from: readonly ModelNode[],
  id: string,
  parentId: string,
): ModelNode[] {
  const lowest = Math.min(
    ...from
      .filter((node) => node.parentId === parentId)
      .map((n) => n.sortOrder),
  );
  return from.map((node) =>
    node.id === id
      ? {
          ...node,
          parentId,
          sortOrder: lowest - 1000,
          version: node.version + 1,
        }
      : node,
  );
}

const MOVE_H2: Intent = {
  kind: 'move',
  blockId: 'h2',
  position: { parentId: 'c2', previousId: null, nextId: 'h3' },
};

function responseFor(nodes: readonly ModelNode[], version = 6): EditResponse {
  return {
    ok: true,
    pageVersion: version,
    tree: nodes,
    createdIds: [],
    deletedIds: [],
    patch: null,
  };
}

type Setup = {
  readonly store: ReturnType<typeof createEditorStore>;
  readonly runner: ReturnType<typeof createSaveRunner>;
  readonly edit: ReturnType<typeof vi.fn>;
  readonly treeRead: ReturnType<typeof vi.fn>;
};

function setup(
  edit: (pageId: string, request: EditRequest) => Promise<EditResponse>,
  treeRead: () => Promise<{
    ok: true;
    pageVersion: number;
    tree: readonly ModelNode[];
  }> = () => Promise.reject(new Error('not read')),
): Setup {
  const store = createEditorStore();
  store.opened(session());
  const editFn = vi.fn(edit);
  const treeFn = vi.fn(treeRead);
  const api = { edit: editFn, tree: treeFn } as unknown as ApiClient;
  const runner = createSaveRunner({
    store,
    api,
    queryClient: new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    }),
    frame: () => null,
    frameUrl: '/x?_edit=frame',
    hooks: () => null,
    idleMs: 1000,
  });
  return { store, runner, edit: editFn, treeRead: treeFn };
}

function performMove(setupResult: Setup, intent: Intent = MOVE_H2): void {
  const { store, runner } = setupResult;
  const model = store.getState().model;
  if (model === null) throw new Error('not open');
  runner.perform(
    intent,
    buildUndoEntry(intent, model, { kind: 'moved', itemId: 'h2' }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the save runner', () => {
  it('sends one request for a structural action and replaces the model only after it succeeded', async () => {
    let release: (value: EditResponse) => void = () => undefined;
    const pending = new Promise<EditResponse>((resolve) => {
      release = resolve;
    });
    const ctx = setup(() => pending);
    performMove(ctx);
    // the mutation starts its function a few microtasks after `mutate`
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.edit).toHaveBeenCalledTimes(1);
    const [pageId, request] = ctx.edit.mock.calls[0] as [string, EditRequest];
    expect(pageId).toBe('p1');
    expect(request.basePageVersion).toBe(5);
    expect(request.ops).toEqual([
      expect.objectContaining({ op: 'move', blockId: 'h2', baseVersion: 1 }),
    ]);
    // nothing has changed in the model while the request is out
    expect(ctx.store.getState().model?.get('h2')?.parentId).toBe('c1');
    expect(ctx.store.getState().queue.status).toBe('saving');

    release(responseFor(movedToTop(tree, 'h2', 'c2')));
    expect(await ctx.runner.flush()).toBe(true);
    const state = ctx.store.getState();
    expect(state.model?.get('h2')?.parentId).toBe('c2');
    expect(state.pageVersion).toBe(6);
    expect(state.queue.status).toBe('saved');
    // the moved item is selected, in its new container
    expect(state.selection).toEqual({ scopeId: 'c2', selectedId: 'h2' });
    expect(state.flash?.id).toBe('h2');
  });

  it('keeps the previous structure and offers a retry when the network fails, then saves on retry', async () => {
    let fail = true;
    const ctx = setup(() =>
      fail
        ? Promise.reject(new ApiRequestError(null, null))
        : Promise.resolve(responseFor(movedToTop(tree, 'h2', 'c2'))),
    );
    performMove(ctx);
    expect(await ctx.runner.flush()).toBe(false);

    const failed = ctx.store.getState();
    expect(failed.queue.status).toBe('failed');
    expect(failed.queue.lastFailure).toBe('network');
    expect(failed.model?.get('h2')?.parentId).toBe('c1');

    fail = false;
    ctx.runner.retry();
    expect(await ctx.runner.flush()).toBe(true);
    expect(ctx.store.getState().model?.get('h2')?.parentId).toBe('c2');
    expect(ctx.store.getState().queue.status).toBe('saved');
  });

  it('drops a refused write, leaves the page alone and takes it off the undo stack', async () => {
    const ctx = setup(() =>
      Promise.reject(new ApiRequestError(422, 'placement')),
    );
    performMove(ctx);
    await ctx.runner.flush();

    const state = ctx.store.getState();
    expect(state.queue.status).toBe('failed');
    expect(state.queue.lastFailure).toBe('refused');
    expect(state.model?.get('h2')?.parentId).toBe('c1');
    expect(state.undo.undo).toHaveLength(0);
  });

  it('merges quick property edits and sends them after the idle time', async () => {
    const ctx = setup((_, request) =>
      Promise.resolve(responseFor(tree, 5 + request.ops.length)),
    );
    const edit = (text: string): void => {
      ctx.runner.perform(
        { kind: 'update', blockId: 'h1', props: { text } },
        null,
      );
    };
    edit('a');
    edit('ab');
    edit('abc');
    expect(ctx.edit).not.toHaveBeenCalled();
    expect(ctx.store.getState().queue.status).toBe('saving');

    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.edit).toHaveBeenCalledTimes(1);
    const [, request] = ctx.edit.mock.calls[0] as [string, EditRequest];
    expect(request.ops).toEqual([
      expect.objectContaining({ op: 'update', props: { text: 'abc' } }),
    ]);
  });

  it('sends pending property edits at once when flushed', async () => {
    const ctx = setup(() => Promise.resolve(responseFor(tree)));
    ctx.runner.perform(
      { kind: 'update', blockId: 'h1', props: { text: 'x' } },
      null,
    );
    expect(await ctx.runner.flush()).toBe(true);
    expect(ctx.edit).toHaveBeenCalledTimes(1);
  });

  it('sends a blurred block at once, and closes the burst of keystrokes as one undo step', async () => {
    const ctx = setup((_, request) =>
      Promise.resolve(responseFor(tree, 5 + request.ops.length)),
    );
    const type = (text: string): void => {
      const intent: Intent = { kind: 'update', blockId: 'h1', props: { text } };
      const model = ctx.store.getState().model;
      if (model === null) throw new Error('not open');
      ctx.runner.perform(
        intent,
        buildUndoEntry(
          intent,
          model,
          { kind: 'changed', itemId: 'h1', property: 'Text' },
          { coalesceKey: 'h1:text', open: true },
        ),
      );
    };
    type('a');
    type('ab');
    expect(ctx.store.getState().undo.undo).toHaveLength(1);
    expect(ctx.store.getState().undo.undo[0]?.open).toBe(true);

    ctx.runner.ready('h1');
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.edit).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState().undo.undo[0]?.open).toBe(false);

    // typing again after the blur is a new step
    type('abc');
    expect(ctx.store.getState().undo.undo).toHaveLength(2);
  });

  it('writes the undo of a property change at once and asks for the block to be re-rendered', async () => {
    const ctx = setup((_, request) =>
      Promise.resolve(responseFor(tree, 5 + request.ops.length)),
    );
    const intent: Intent = {
      kind: 'update',
      blockId: 'h1',
      props: { text: 'x' },
    };
    const model = ctx.store.getState().model;
    if (model === null) throw new Error('not open');
    ctx.runner.perform(
      intent,
      buildUndoEntry(intent, model, {
        kind: 'changed',
        itemId: 'h1',
        property: 'Text',
      }),
    );
    await ctx.runner.flush();

    ctx.runner.undo();
    await vi.advanceTimersByTimeAsync(0);
    // no idle wait: the undo is its own write, carrying the fragments
    expect(ctx.edit).toHaveBeenCalledTimes(2);
    const [, request] = ctx.edit.mock.calls[1] as [string, EditRequest];
    expect(request.fragments).toBe(true);
    expect(request.ops[0]).toMatchObject({ op: 'update', blockId: 'h1' });
    expect(ctx.store.getState().announcement).toBe(
      'Undone: Changed Text of heading.',
    );
  });

  it('undoes a move by writing the inverse as a new write, and redoes it', async () => {
    const ctx = setup((_, request) => {
      const op = request.ops[0];
      if (op?.op !== 'move') throw new Error('expected a move');
      return Promise.resolve(
        op.position.parentId === 'c2'
          ? responseFor(movedToTop(tree, 'h2', 'c2'), 6)
          : responseFor(tree, 7),
      );
    });
    performMove(ctx);
    await ctx.runner.flush();
    expect(ctx.store.getState().undo.undo).toHaveLength(1);

    ctx.runner.undo();
    await ctx.runner.flush();
    expect(ctx.edit).toHaveBeenCalledTimes(2);
    const [, secondRequest] = ctx.edit.mock.calls[1] as [string, EditRequest];
    const inverse = secondRequest.ops[0];
    expect(inverse).toMatchObject({
      op: 'move',
      blockId: 'h2',
      position: { parentId: 'c1' },
    });
    expect(ctx.store.getState().model?.get('h2')?.parentId).toBe('c1');
    expect(ctx.store.getState().announcement).toBe('Undone: Moved heading.');
    expect(ctx.store.getState().undo.redo).toHaveLength(1);

    ctx.runner.redo();
    await ctx.runner.flush();
    expect(ctx.store.getState().announcement).toBe('Redone: Moved heading.');
    expect(ctx.edit).toHaveBeenCalledTimes(3);
    // undo and redo are not recorded as new actions
    expect(ctx.store.getState().undo.undo).toHaveLength(1);
  });

  it('selects the neighbour after a delete, and undo brings the item back under its own id and says so', async () => {
    const without = tree.filter((node) => node.id !== 'h2');
    const ctx = setup((_, request) =>
      Promise.resolve(
        request.ops[0]?.op === 'delete'
          ? responseFor(without, 6)
          : responseFor(tree, 7),
      ),
    );
    const model = ctx.store.getState().model;
    if (model === null) throw new Error('not open');
    const intent: Intent = { kind: 'delete', blockId: 'h2' };
    ctx.runner.perform(
      intent,
      buildUndoEntry(intent, model, { kind: 'deleted', itemId: 'h2' }),
      { selectId: 'h1', flash: false },
    );
    await ctx.runner.flush();
    expect(ctx.store.getState().model?.get('h2')).toBeUndefined();
    expect(ctx.store.getState().selection).toEqual({
      scopeId: 'c1',
      selectedId: 'h1',
    });
    expect(ctx.store.getState().flash).toBeNull();

    ctx.runner.undo();
    await ctx.runner.flush();
    const [, request] = ctx.edit.mock.calls[1] as [string, EditRequest];
    expect(request.ops[0]).toMatchObject({
      op: 'insert',
      node: { id: 'h2', type: 'heading' },
      position: { parentId: 'c1', previousId: 'h1' },
    });
    const state = ctx.store.getState();
    expect(state.selection).toEqual({ scopeId: 'c1', selectedId: 'h2' });
    expect(state.announcement).toBe('Restored heading.');
  });

  it('selects a new block, says it was added and asks for its properties when a required value is missing', async () => {
    const added: ModelNode = {
      ...buildNodes([block('h9', 'heading')])[0]!,
      parentId: 'c1',
      sortOrder: 2500,
      needsInput: ['text'],
    };
    const ctx = setup(() => Promise.resolve(responseFor([...tree, added], 6)));
    const model = ctx.store.getState().model;
    if (model === null) throw new Error('not open');
    const intent: Intent = {
      kind: 'insert',
      position: { parentId: 'c1', previousId: 'h2', nextId: null },
      node: { id: 'h9', type: 'heading' },
    };
    ctx.runner.perform(
      intent,
      buildUndoEntry(intent, model, { kind: 'added', itemId: 'h9' }),
    );
    await ctx.runner.flush();
    const state = ctx.store.getState();
    expect(state.selection).toEqual({ scopeId: 'c1', selectedId: 'h9' });
    expect(state.announcement).toBe('Added heading. Needs input.');
    expect(state.propertiesRequest?.id).toBe('h9');
  });

  describe('when a retry meets a stale version after the first attempt got no answer', () => {
    function staleAfterNetworkLoss(freshTree: readonly ModelNode[]): Setup {
      let attempts = 0;
      return setup(
        () => {
          attempts += 1;
          return Promise.reject(
            attempts === 1
              ? new ApiRequestError(null, null)
              : new ApiRequestError(409, 'stale-page'),
          );
        },
        () => Promise.resolve({ ok: true, pageVersion: 6, tree: freshTree }),
      );
    }

    it('marks the save done when the tree already holds the move', async () => {
      const ctx = staleAfterNetworkLoss(movedToTop(tree, 'h2', 'c2'));
      performMove(ctx);
      await ctx.runner.flush();
      expect(ctx.store.getState().queue.lastFailure).toBe('network');

      ctx.runner.retry();
      expect(await ctx.runner.flush()).toBe(true);
      const state = ctx.store.getState();
      expect(state.queue.status).toBe('saved');
      expect(state.model?.get('h2')?.parentId).toBe('c2');
      expect(state.pageVersion).toBe(6);
    });

    it('pauses saving with the reason when the tree holds something else', async () => {
      const ctx = staleAfterNetworkLoss(tree);
      performMove(ctx);
      await ctx.runner.flush();

      ctx.runner.retry();
      expect(await ctx.runner.flush()).toBe(false);
      const { queue, model } = ctx.store.getState();
      expect(queue.status).toBe('paused');
      expect(queue.pauseReason).toBe('stale');
      expect(model?.get('h2')?.parentId).toBe('c1');
    });
  });
});

describe('failures that are not a refusal of the change', () => {
  it('pauses on a lock that changed during the write and keeps the edits behind it queued', async () => {
    const ctx = setup(() =>
      Promise.reject(new ApiRequestError(409, 'lock-changed')),
    );
    performMove(ctx);
    performMove(ctx, {
      kind: 'delete',
      blockId: 'h1',
    });
    expect(await ctx.runner.flush()).toBe(false);
    // only the first write went out; the second is not shed or sent on
    expect(ctx.edit).toHaveBeenCalledTimes(1);
    const { queue, notice } = ctx.store.getState();
    expect(queue.status).toBe('paused');
    expect(queue.pauseReason).toBe('locked');
    expect(queue.entries).toHaveLength(2);
    // the lock could not be read, so the editor is told the page changed
    expect(notice?.kind).toBe('stale');
  });

  it('holds the write for a retry on a 429 instead of dropping it', async () => {
    const ctx = setup(() => Promise.reject(new ApiRequestError(429, null)));
    performMove(ctx);
    expect(await ctx.runner.flush()).toBe(false);
    const { queue } = ctx.store.getState();
    expect(queue.status).toBe('failed');
    expect(queue.lastFailure).toBe('network');
    expect(queue.entries).toHaveLength(1);
  });

  it('pauses instead of shedding the edit when the page is gone or the permission was lost', async () => {
    const ctx = setup(() =>
      Promise.reject(new ApiRequestError(404, 'not-found')),
    );
    performMove(ctx);
    expect(await ctx.runner.flush()).toBe(false);
    const { queue, notice } = ctx.store.getState();
    expect(queue.status).toBe('paused');
    expect(queue.pauseReason).toBe('stale');
    expect(notice?.kind).toBe('stale');
  });

  it('puts the entry of a refused undo back on the undo stack', async () => {
    let refuse = false;
    const ctx = setup(() =>
      refuse
        ? Promise.reject(new ApiRequestError(422, 'placement'))
        : Promise.resolve(responseFor(movedToTop(tree, 'h2', 'c2'))),
    );
    performMove(ctx);
    await ctx.runner.flush();
    expect(ctx.store.getState().undo.undo).toHaveLength(1);

    refuse = true;
    ctx.runner.undo();
    await ctx.runner.flush();
    const { undo } = ctx.store.getState();
    expect(undo.undo).toHaveLength(1);
    expect(undo.redo).toHaveLength(0);
  });

  it('drops the undo entry of a refused typed edit', async () => {
    const ctx = setup(() =>
      Promise.reject(new ApiRequestError(422, 'invalid-props')),
    );
    const intent: Intent = {
      kind: 'update',
      blockId: 'h1',
      props: { text: 'x' },
    };
    const model = ctx.store.getState().model;
    if (model === null) throw new Error('not open');
    ctx.runner.perform(
      intent,
      buildUndoEntry(
        intent,
        model,
        { kind: 'changed', itemId: 'h1', property: 'Text' },
        { coalesceKey: 'h1:text', open: true },
      ),
    );
    ctx.runner.ready('h1');
    await ctx.runner.flush();
    expect(ctx.store.getState().queue.lastFailure).toBe('refused');
    expect(ctx.store.getState().undo.undo).toHaveLength(0);
  });
});

describe('the metadata of a write', () => {
  it('goes with the entry an undo of a typed change merged into, and does not leak onto the next write', async () => {
    const ctx = setup((_, request) =>
      Promise.resolve(responseFor(tree, 5 + request.ops.length)),
    );
    const type = (blockId: string, text: string): void => {
      const intent: Intent = { kind: 'update', blockId, props: { text } };
      const model = ctx.store.getState().model;
      if (model === null) throw new Error('not open');
      ctx.runner.perform(
        intent,
        buildUndoEntry(intent, model, {
          kind: 'changed',
          itemId: blockId,
          property: 'Text',
        }),
      );
    };
    type('h1', 'one');
    await ctx.runner.flush();
    ctx.store.select({ scopeId: 'c2', selectedId: 'h3' });

    // a new edit of the block waits for its idle time; the undo merges into it
    type('h1', 'two');
    ctx.runner.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.edit).toHaveBeenCalledTimes(2);
    // the undo write's own selection and announcements applied to that entry
    expect(ctx.store.getState().selection.selectedId).toBe('h1');

    // the next write, a typed edit of another block, carries no leftover of it
    ctx.store.select({ scopeId: 'c2', selectedId: 'h3' });
    type('h2', 'next');
    await ctx.runner.flush();
    expect(ctx.store.getState().selection.selectedId).toBe('h3');
  });
});

describe('actions held until the queue is saved', () => {
  const withText = (text: string): ModelNode[] =>
    tree.map((node) =>
      node.id === 'h1'
        ? { ...node, props: { text }, version: node.version + 1 }
        : node,
    );

  it('runs an action at once when nothing is queued', () => {
    const ctx = setup(() => Promise.resolve(responseFor(tree)));
    let ran = false;
    ctx.runner.whenSaved(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('builds the undo of a delete from the block as saved, not as it was before a pending edit', async () => {
    const ctx = setup(() => Promise.resolve(responseFor(withText('typed'))));
    ctx.runner.perform(
      { kind: 'update', blockId: 'h1', props: { text: 'typed' } },
      null,
    );
    ctx.runner.ready('h1');
    const del: Intent = { kind: 'delete', blockId: 'h1' };
    let captured: unknown = null;
    ctx.runner.whenSaved(() => {
      const model = ctx.store.getState().model;
      if (model === null) throw new Error('not open');
      const entry = buildUndoEntry(del, model, {
        kind: 'deleted',
        itemId: 'h1',
      });
      captured = entry.inverse;
    });
    // the edit is still in flight: the action has not been built yet
    expect(captured).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toMatchObject({
      kind: 'insert',
      node: { id: 'h1', props: { text: 'typed' } },
    });
  });

  it('builds a second action after the first one has been saved, in order', async () => {
    const ctx = setup(() =>
      Promise.resolve(responseFor(movedToTop(tree, 'h2', 'c2'))),
    );
    const seen: (string | null | undefined)[] = [];
    const action = (): void => {
      seen.push(ctx.store.getState().model?.get('h2')?.parentId);
      if (seen.length === 1) performMove(ctx);
    };
    ctx.runner.whenSaved(action);
    // the first ran at once and its write is in flight; the second must wait for it
    ctx.runner.whenSaved(action);
    expect(seen).toEqual(['c1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['c1', 'c2']);
  });

  it('drops a held action and says so when saving fails', async () => {
    const ctx = setup(() => Promise.reject(new ApiRequestError(null, null)));
    performMove(ctx);
    let ran = false;
    ctx.runner.whenSaved(() => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toBe(false);
    expect(ctx.store.getState().announcement).toBe(
      'Could not save your changes',
    );
  });
});

describe('selectionAfterWrite', () => {
  const model = createTreeModel(tree);

  it('selects the acted item inside its new container', () => {
    expect(
      selectionAfterWrite(model, { scopeId: 'c1', selectedId: 'h1' }, 'h3'),
    ).toEqual({ scopeId: 'c2', selectedId: 'h3' });
  });

  it('falls back to the container of an item that is gone', () => {
    expect(
      selectionAfterWrite(model, { scopeId: 'c1', selectedId: 'gone' }, null),
    ).toEqual({ scopeId: 's1', selectedId: 'c1' });
  });
});
