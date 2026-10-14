import type {
  EditNode,
  EditOp,
  EditPosition,
  EditRequest,
  ModelLayout,
} from '../../api-types.js';
import type { TreeModel } from './tree-model.js';

/**
 * One thing the editor wants written. Every inserted node carries an id the
 * caller minted with `crypto.randomUUID()`, so an undo can restore it under the
 * same id. A property update names only the keys it changes.
 */
export type Intent =
  | {
      readonly kind: 'insert';
      readonly position: EditPosition;
      readonly node: EditNode;
    }
  | {
      readonly kind: 'update';
      readonly blockId: string;
      readonly props?: Readonly<Record<string, unknown>>;
      readonly layout?: ModelLayout | null;
    }
  | {
      readonly kind: 'move';
      readonly blockId: string;
      readonly position: EditPosition;
    }
  | { readonly kind: 'delete'; readonly blockId: string }
  | {
      readonly kind: 'duplicate';
      readonly blockId: string;
      readonly newId: string;
    }
  | { readonly kind: 'group'; readonly intents: readonly Intent[] };

export type SaveStatus = 'saved' | 'saving' | 'failed' | 'paused';

export type FailureKind =
  | 'network'
  | 'stale'
  | 'locked'
  | 'session'
  | 'refused';

export type PauseReason = 'stale' | 'locked' | 'session';

export type QueueEntry = {
  readonly seq: number;
  readonly intent: Intent;
  /** Ready entries may be sent; a property edit is not ready until idle or blur. */
  readonly ready: boolean;
  /** Ask the server for rendered fragments of what this write changed. */
  readonly fragments: boolean;
};

export type QueueState = {
  readonly entries: readonly QueueEntry[];
  readonly inFlight: QueueEntry | null;
  readonly status: SaveStatus;
  readonly lastFailure: FailureKind | null;
  readonly pauseReason: PauseReason | null;
  readonly nextSeq: number;
};

export function createQueue(): QueueState {
  return {
    entries: [],
    inFlight: null,
    status: 'saved',
    lastFailure: null,
    pauseReason: null,
    nextSeq: 1,
  };
}

const NO_IDS: ReadonlySet<string> = new Set<string>();

/** A save that failed on the network waits for an explicit retry. */
function holdsAfterNetworkFailure(state: QueueState): boolean {
  return state.status === 'failed' && state.lastFailure === 'network';
}

function canSend(state: QueueState): boolean {
  return (
    state.inFlight === null &&
    state.status !== 'paused' &&
    !holdsAfterNetworkFailure(state)
  );
}

function mergeProps(
  base: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = { ...base, ...changes };
  // A key set to undefined is a key the edit removes.
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
}

function mergeUpdates(
  older: Extract<Intent, { kind: 'update' }>,
  newer: Extract<Intent, { kind: 'update' }>,
): Intent {
  const props =
    older.props === undefined && newer.props === undefined
      ? undefined
      : { ...older.props, ...newer.props };
  const layout = newer.layout === undefined ? older.layout : newer.layout;
  return {
    kind: 'update',
    blockId: older.blockId,
    ...(props === undefined ? {} : { props }),
    ...(layout === undefined ? {} : { layout }),
  };
}

/** Whether the intent names the block, so a write queued after it must not jump in front of it. */
function touchesBlock(intent: Intent, blockId: string): boolean {
  switch (intent.kind) {
    case 'insert': {
      // A node without an id cannot be ruled out.
      const ids = insertedIds(intent.node);
      return ids === null || ids.includes(blockId);
    }
    case 'duplicate':
      return intent.blockId === blockId || intent.newId === blockId;
    case 'update':
    case 'move':
    case 'delete':
      return intent.blockId === blockId;
    case 'group':
      return intent.intents.some((member) => touchesBlock(member, blockId));
  }
}

/**
 * The pending update a new update of `blockId` may merge into: the latest one
 * for the block, and only when nothing queued after it touches the block. A
 * structural write in between (a delete and the insert an undo makes, a move)
 * must keep its place, so the new edit then gets an entry of its own.
 */
function mergeIndex(entries: readonly QueueEntry[], blockId: string): number {
  const index = entries.findLastIndex(
    (entry) =>
      entry.intent.kind === 'update' && entry.intent.blockId === blockId,
  );
  if (index === -1) return -1;
  const blocked = entries
    .slice(index + 1)
    .some((entry) => touchesBlock(entry.intent, blockId));
  return blocked ? -1 : index;
}

function settledStatus(entries: readonly QueueEntry[]): SaveStatus {
  return entries.length > 0 ? 'saving' : 'saved';
}

/**
 * Add an intent. Structural intents (anything but a property update) are ready
 * at once and make every pending property edit ready first, so saves leave in
 * the order the actions were made. A property update merges into the latest
 * pending update of the same block (the latest value wins) and keeps that
 * entry's place, unless a write queued after it touches the block: then it is
 * queued behind that write.
 */
export function enqueue(
  state: QueueState,
  intent: Intent,
  options: { readonly immediate: boolean; readonly fragments?: boolean },
): QueueState {
  const immediate = options.immediate || intent.kind !== 'update';
  const fragments = options.fragments === true;

  let entries: readonly QueueEntry[] = immediate
    ? state.entries.map((entry) =>
        entry.ready ? entry : { ...entry, ready: true },
      )
    : state.entries;
  let nextSeq = state.nextSeq;

  const index =
    intent.kind === 'update' ? mergeIndex(entries, intent.blockId) : -1;
  const existing = index === -1 ? undefined : entries[index];

  if (
    intent.kind === 'update' &&
    existing !== undefined &&
    existing.intent.kind === 'update'
  ) {
    const merged: QueueEntry = {
      ...existing,
      intent: mergeUpdates(existing.intent, intent),
      ready: existing.ready || immediate,
      fragments: existing.fragments || fragments,
    };
    entries = entries.map((entry, at) => (at === index ? merged : entry));
  } else {
    entries = [
      ...entries,
      { seq: nextSeq, intent, ready: immediate, fragments },
    ];
    nextSeq += 1;
  }

  const hold = state.status === 'paused' || holdsAfterNetworkFailure(state);
  return {
    ...state,
    entries,
    nextSeq,
    status: hold ? state.status : 'saving',
    lastFailure: hold ? state.lastFailure : null,
  };
}

/**
 * The idle timer fired or a field lost focus: make pending property edits
 * ready. With a block id, that block's pending update and everything queued
 * before it become ready, so the order is kept.
 */
export function markReady(state: QueueState, blockId?: string): QueueState {
  let through = state.entries.length - 1;
  if (blockId !== undefined) {
    through = -1;
    state.entries.forEach((entry, at) => {
      if (entry.intent.kind === 'update' && entry.intent.blockId === blockId) {
        through = at;
      }
    });
    if (through === -1) return state;
  }
  if (state.entries.every((entry, at) => entry.ready || at > through)) {
    return state;
  }
  return {
    ...state,
    entries: state.entries.map((entry, at) =>
      at <= through && !entry.ready ? { ...entry, ready: true } : entry,
    ),
  };
}

function insertedNodes(
  node: EditNode,
  into: Map<string, Readonly<Record<string, unknown>>>,
): void {
  if (node.id !== undefined) into.set(node.id, node.props ?? {});
  for (const child of node.children ?? []) insertedNodes(child, into);
}

/**
 * Where an item goes, checked against the tree as it is now. A neighbour that is
 * no longer among the parent's children is dropped; when every named neighbour is
 * gone the item goes first. `known` lists ids created earlier in the same request.
 */
export function resolvePosition(
  model: TreeModel,
  position: EditPosition,
  known: ReadonlySet<string> = NO_IDS,
  movingId?: string,
): EditPosition {
  const previousId = position.previousId ?? null;
  const nextId = position.nextId ?? null;
  if (previousId === null && nextId === null) {
    return { parentId: position.parentId };
  }
  const siblings = model.childrenOf(position.parentId).map((node) => node.id);
  const survives = (id: string | null): id is string =>
    id !== null && id !== movingId && (siblings.includes(id) || known.has(id));
  const previous = survives(previousId) ? previousId : null;
  const next = survives(nextId) ? nextId : null;
  if (previous === null && next === null) {
    const first = siblings.find((id) => id !== movingId);
    return first === undefined
      ? { parentId: position.parentId }
      : { parentId: position.parentId, nextId: first };
  }
  return {
    parentId: position.parentId,
    ...(previous === null ? {} : { previousId: previous }),
    ...(next === null ? {} : { nextId: next }),
  };
}

type BuildContext = {
  readonly model: TreeModel;
  /** Blocks created earlier in the same request, with the props they were created with. */
  readonly created: Map<string, Readonly<Record<string, unknown>>>;
};

/** Versions and positions are read here, from the model, when the request is built. */
function opsFor(intent: Intent, ctx: BuildContext): EditOp[] {
  const { model, created } = ctx;
  switch (intent.kind) {
    case 'insert': {
      const position = resolvePosition(
        model,
        intent.position,
        new Set(created.keys()),
      );
      insertedNodes(intent.node, created);
      return [{ op: 'insert', position, node: intent.node }];
    }
    case 'update': {
      const node = model.get(intent.blockId);
      const createdProps = created.get(intent.blockId);
      if (node === undefined && createdProps === undefined) return [];
      if (intent.props === undefined && intent.layout === undefined) return [];
      // The server replaces a block's properties as a whole, so the changed
      // keys go on top of what the block holds now.
      const props =
        intent.props === undefined
          ? undefined
          : mergeProps(node?.props ?? createdProps ?? {}, intent.props);
      if (props !== undefined && node === undefined) {
        created.set(intent.blockId, props);
      }
      return [
        {
          op: 'update',
          blockId: intent.blockId,
          // A block created in this very request starts at version 1.
          baseVersion: node?.version ?? 1,
          ...(props === undefined ? {} : { props }),
          ...(intent.layout === undefined ? {} : { layout: intent.layout }),
        },
      ];
    }
    case 'move': {
      const node = model.get(intent.blockId);
      if (node === undefined) return [];
      return [
        {
          op: 'move',
          blockId: intent.blockId,
          baseVersion: node.version,
          position: resolvePosition(
            model,
            intent.position,
            new Set(created.keys()),
            intent.blockId,
          ),
        },
      ];
    }
    case 'delete': {
      const node = model.get(intent.blockId);
      if (node === undefined) return [];
      return [
        { op: 'delete', blockId: intent.blockId, baseVersion: node.version },
      ];
    }
    case 'duplicate': {
      const node = model.get(intent.blockId);
      if (node === undefined) return [];
      created.set(intent.newId, node.props);
      return [
        { op: 'duplicate', blockId: intent.blockId, newId: intent.newId },
      ];
    }
    case 'group':
      return intent.intents.flatMap((member) => opsFor(member, ctx));
  }
}

function buildOps(intent: Intent, model: TreeModel): EditOp[] {
  return opsFor(intent, { model, created: new Map() });
}

function dropHeadEntry(state: QueueState): QueueState {
  const entries = state.entries.slice(1);
  return {
    ...state,
    entries,
    status:
      state.status === 'saving' && entries.length === 0
        ? 'saved'
        : state.status,
  };
}

/**
 * Drop leading ready entries whose request would be empty because every block
 * they name is gone. `takeNext` does this itself, but a caller that gets `null`
 * back never sees the pruned state, so call this first when `hasPending` stays
 * true with nothing to send.
 */
export function pruneEmpty(state: QueueState, model: TreeModel): QueueState {
  let current = state;
  while (canSend(current)) {
    const head = current.entries[0];
    if (head === undefined || !head.ready) break;
    if (buildOps(head.intent, model).length > 0) break;
    current = dropHeadEntry(current);
  }
  return current;
}

/**
 * Build the next request from the head entry alone: one save, one batch. Null
 * while something is in flight, saving is paused or held for a retry, or the
 * head is not ready.
 */
export function takeNext(
  state: QueueState,
  model: TreeModel,
  pageVersion: number,
): { state: QueueState; request: EditRequest; entry: QueueEntry } | null {
  const current = pruneEmpty(state, model);
  if (!canSend(current)) return null;
  const head = current.entries[0];
  if (head === undefined || !head.ready) return null;
  const request: EditRequest = {
    basePageVersion: pageVersion,
    ops: buildOps(head.intent, model),
    ...(head.fragments ? { fragments: true } : {}),
  };
  return {
    state: {
      ...current,
      entries: current.entries.slice(1),
      inFlight: head,
      status: 'saving',
      lastFailure: null,
      pauseReason: null,
    },
    request,
    entry: head,
  };
}

/** The in-flight write was saved. */
export function onSuccess(state: QueueState): QueueState {
  return {
    ...state,
    inFlight: null,
    status: settledStatus(state.entries),
    lastFailure: null,
    pauseReason: null,
  };
}

/**
 * The in-flight write failed. A network failure keeps the entry for Retry; a
 * stale, locked or session failure pauses saving and keeps everything queued;
 * a refused write (placement or validation) drops the entry, because sending
 * it again cannot succeed.
 */
export function onFailure(state: QueueState, kind: FailureKind): QueueState {
  const entry = state.inFlight;
  const base = { ...state, inFlight: null, lastFailure: kind };
  if (kind === 'refused') {
    return { ...base, status: 'failed', pauseReason: null };
  }
  if (kind === 'network') {
    return {
      ...base,
      entries:
        entry === null
          ? state.entries
          : [{ ...entry, ready: false }, ...state.entries],
      status: 'failed',
      pauseReason: null,
    };
  }
  return {
    ...base,
    entries:
      entry === null
        ? state.entries
        : [{ ...entry, ready: true }, ...state.entries],
    status: 'paused',
    pauseReason: kind,
  };
}

/**
 * Send the held entry again after a network failure, or once a pause is
 * resolved. Versions are read from the model at send time, so a caller that has
 * refreshed the model after a stale response resends against fresh versions.
 */
export function retry(state: QueueState): QueueState {
  const held = holdsAfterNetworkFailure(state) || state.status === 'paused';
  if (!held) return state;
  const entries = state.entries.map((entry, at) =>
    at === 0 ? { ...entry, ready: true } : entry,
  );
  return {
    ...state,
    entries,
    status: settledStatus(entries),
    lastFailure: null,
    pauseReason: null,
  };
}

/** The held head entry turned out to be saved already (see `reconcileAfterStale`). */
export function dropHead(state: QueueState): QueueState {
  const entries = state.entries.slice(1);
  return {
    ...state,
    entries,
    status: state.inFlight === null ? settledStatus(entries) : 'saving',
    lastFailure: null,
    pauseReason: null,
  };
}

/** Forget everything not yet sent: the lock was lost or the page reloaded. */
export function discardPending(state: QueueState): QueueState {
  return {
    ...state,
    entries: [],
    status: state.inFlight === null ? 'saved' : 'saving',
    lastFailure: null,
    pauseReason: null,
  };
}

export function hasPending(state: QueueState): boolean {
  return state.entries.length > 0 || state.inFlight !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item: unknown, at) => deepEqual(item, right[at]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function insertedIds(node: EditNode): string[] | null {
  if (node.id === undefined) return null;
  const ids = [node.id];
  for (const child of node.children ?? []) {
    const below = insertedIds(child);
    if (below === null) return null;
    ids.push(...below);
  }
  return ids;
}

function alreadyApplied(intent: Intent, fresh: TreeModel): boolean {
  switch (intent.kind) {
    case 'insert': {
      const ids = insertedIds(intent.node);
      return ids !== null && ids.every((id) => fresh.get(id) !== undefined);
    }
    case 'duplicate':
      return fresh.get(intent.newId) !== undefined;
    case 'delete':
      return fresh.get(intent.blockId) === undefined;
    case 'update': {
      const node = fresh.get(intent.blockId);
      if (node === undefined) return false;
      const propsMatch = Object.entries(intent.props ?? {}).every(
        ([key, value]) => deepEqual(node.props[key], value),
      );
      const layoutMatches =
        intent.layout === undefined ||
        deepEqual(node.layout ?? null, intent.layout);
      return propsMatch && layoutMatches;
    }
    case 'move': {
      const node = fresh.get(intent.blockId);
      if (node === undefined || node.parentId !== intent.position.parentId) {
        return false;
      }
      const siblings = fresh.childrenOf(node.parentId);
      const at = siblings.findIndex((sibling) => sibling.id === node.id);
      const previousId = intent.position.previousId ?? null;
      const nextId = intent.position.nextId ?? null;
      if (previousId !== null && siblings[at - 1]?.id !== previousId) {
        return false;
      }
      if (nextId !== null && siblings[at + 1]?.id !== nextId) return false;
      // Naming no neighbour means the end of the list.
      return (
        previousId !== null || nextId !== null || at === siblings.length - 1
      );
    }
    case 'group':
      return intent.intents.every((member) => alreadyApplied(member, fresh));
  }
}

/**
 * A write whose retry met a stale version may already have been applied (the
 * response was lost). Judged against a freshly loaded tree: every intended value
 * already there means the entry is saved; anything else is a conflict that must
 * pause saving rather than be resent blindly.
 */
export function reconcileAfterStale(
  entry: QueueEntry,
  fresh: TreeModel,
): 'already-applied' | 'conflict' {
  return alreadyApplied(entry.intent, fresh) ? 'already-applied' : 'conflict';
}
