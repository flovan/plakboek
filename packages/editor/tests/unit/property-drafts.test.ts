import { describe, expect, it } from 'vitest';
import type { ModelNode } from '../../src/api-types.js';
import {
  afterPreview,
  draftValues,
  NO_DRAFTS,
  reconcileDrafts,
  shownValue,
  withChange,
  withValues,
} from '../../src/client/session/property-drafts.js';
import { createQueue, enqueue } from '../../src/client/session/save-queue.js';

const node: ModelNode = {
  id: 'h1',
  parentId: 'c1',
  type: 'heading',
  kind: 'block',
  sortOrder: 1000,
  depth: 2,
  version: 1,
  props: { text: 'Hello', n: 1 },
  layout: null,
  needsInput: [],
  unavailable: null,
};

const savedQueue = createQueue();
const unsavedQueue = enqueue(
  savedQueue,
  { kind: 'update', blockId: 'h1', props: { text: 'Hello!' } },
  { immediate: false },
);

describe('property drafts', () => {
  it('shows the draft over the stored value, and the stored value without one', () => {
    const drafts = withChange(NO_DRAFTS, node, 'text', 'Hel');
    expect(shownValue(drafts, node, 'text')).toBe('Hel');
    expect(shownValue(drafts, node, 'n')).toBe(1);
  });

  it('keeps a draft that is waiting for its render however the queue looks', () => {
    const drafts = withChange(NO_DRAFTS, node, 'text', 'Hel');
    expect(reconcileDrafts(drafts, node, savedQueue)).toBe(drafts);
  });

  it('keeps a queued draft while the block has an unsaved edit and drops it once saved', () => {
    const drafts = afterPreview(
      withChange(NO_DRAFTS, node, 'text', 'Hello!'),
      ['text'],
      null,
    );
    expect(reconcileDrafts(drafts, node, unsavedQueue)).toBe(drafts);
    expect(reconcileDrafts(drafts, node, savedQueue)).toEqual({});
  });

  it('keeps what the engine refused until the stored value changes by other means', () => {
    const drafts = afterPreview(
      withChange(NO_DRAFTS, node, 'n', 9999),
      ['n'],
      ['n'],
    );
    expect(drafts['n']?.stage).toBe('invalid');
    expect(reconcileDrafts(drafts, node, savedQueue)).toBe(drafts);
    const undone = { ...node, props: { ...node.props, n: 5 } };
    expect(reconcileDrafts(drafts, undone, savedQueue)).toEqual({});
  });

  it('leaves a refused draft out of what is rendered and saved', () => {
    let drafts = withChange(NO_DRAFTS, node, 'n', 9999);
    drafts = withChange(drafts, node, 'text', 'Hi');
    drafts = afterPreview(drafts, ['n', 'text'], ['n']);
    expect(draftValues(drafts)).toEqual({ text: 'Hi' });
  });

  it('puts values on top of the props and removes a key set to undefined', () => {
    expect(withValues({ a: 1, b: 2 }, { b: undefined, c: 3 })).toEqual({
      a: 1,
      c: 3,
    });
  });
});
