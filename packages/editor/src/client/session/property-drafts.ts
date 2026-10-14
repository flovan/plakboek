/**
 * What the Properties panel shows for a value the editor has changed and the
 * model does not hold yet. A field never has its own value overwritten while
 * the editor works in it: its draft stands in for the model's value until the
 * change has been saved (and the model agrees), or, for a value the engine
 * refused, until the model's value changes by some other means (an undo).
 *
 * - `previewing`: asked for a render, no answer yet. Always kept.
 * - `queued`: rendered and queued to be saved. Kept while the block has an
 *   edit in the save queue; once none is left the model is the truth.
 * - `invalid`: refused. Kept while the model still holds the value it held when
 *   the editor typed it, so the text they typed is never wiped from under them.
 */
import type { ModelNode } from '../../api-types.js';
import type { Intent, QueueState } from './save-queue.js';

export type DraftStage = 'previewing' | 'queued' | 'invalid';

export type Draft = {
  readonly value: unknown;
  readonly stage: DraftStage;
  /** The model's value when the draft began, to tell a later outside change from none. */
  readonly baseline: unknown;
};

export type Drafts = Readonly<Record<string, Draft>>;

export const NO_DRAFTS: Drafts = Object.freeze({});

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether the queue still holds an edit of this block that has not been saved. */
export function hasUnsavedEdit(queue: QueueState, blockId: string): boolean {
  const edits = (intent: Intent): boolean =>
    intent.kind === 'update' && intent.blockId === blockId;
  return (
    queue.entries.some((entry) => edits(entry.intent)) ||
    (queue.inFlight !== null && edits(queue.inFlight.intent))
  );
}

/** The value a field shows: its draft while it has one, else the model's. */
export function shownValue(
  drafts: Drafts,
  node: ModelNode,
  key: string,
): unknown {
  const draft = drafts[key];
  return draft === undefined ? node.props[key] : draft.value;
}

/** A change to one key: the draft takes the new value and waits for its render. */
export function withChange(
  drafts: Drafts,
  node: ModelNode,
  key: string,
  value: unknown,
): Drafts {
  const earlier = drafts[key];
  return {
    ...drafts,
    [key]: {
      value,
      stage: 'previewing',
      baseline: earlier === undefined ? node.props[key] : earlier.baseline,
    },
  };
}

/**
 * The values to render and save: every draft the engine has not refused, so
 * one refused field never holds back another. A key set to undefined is a key
 * removed.
 */
export function draftValues(drafts: Drafts): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => draft.stage !== 'invalid')
      .map(([key, draft]) => [key, draft.value]),
  );
}

/**
 * The engine's answer to a render of `sent`: accepted (`refused` is null), the
 * sent drafts wait to be saved; refused, the keys it named become invalid and
 * the rest are left for the next render.
 */
export function afterPreview(
  drafts: Drafts,
  sent: readonly string[],
  refused: readonly string[] | null,
): Drafts {
  let changed = false;
  const next: Record<string, Draft> = { ...drafts };
  for (const key of sent) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    if (refused === null) {
      if (draft.stage !== 'previewing') continue;
      next[key] = { ...draft, stage: 'queued' };
      changed = true;
    } else if (refused.includes(key)) {
      next[key] = { ...draft, stage: 'invalid' };
      changed = true;
    }
  }
  return changed ? next : drafts;
}

/**
 * The keys of `sent` whose render got no answer at all (the request failed or
 * the session ended): the drafts still waiting for it. A draft already queued
 * for saving by an earlier render keeps standing.
 */
export function unansweredKeys(
  drafts: Drafts,
  sent: readonly string[],
): readonly string[] {
  return sent.filter((key) => drafts[key]?.stage === 'previewing');
}

/** Drops the drafts the model has caught up with; the same object back when none goes. */
export function reconcileDrafts(
  drafts: Drafts,
  node: ModelNode,
  queue: QueueState,
): Drafts {
  const unsaved = hasUnsavedEdit(queue, node.id);
  const kept = Object.entries(drafts).filter(([key, draft]) => {
    if (draft.stage === 'previewing') return true;
    if (draft.stage === 'queued') return unsaved;
    return same(node.props[key], draft.baseline);
  });
  return kept.length === Object.keys(drafts).length
    ? drafts
    : Object.fromEntries(kept);
}

/** The block's props with `values` on top; a value of undefined removes its key. */
export function withValues(
  props: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...props, ...values }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}
