import { describe, expect, it, vi } from 'vitest';
import type { EditorSession, LockView } from '../../src/api-types.js';
import { announceSelection } from '../../src/client/session/selection-announcement.js';
import { selectByClick } from '../../src/client/session/scope.js';
import { createEditorStore } from '../../src/client/session/store.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import {
  block,
  buildNodes,
  catalogueEntry,
  column,
  section,
} from './support/model.js';

const MINE: LockView = {
  enabled: true,
  state: 'mine',
  holder: null,
  canTakeOver: false,
  expiresAt: null,
};
const OTHER: LockView = {
  enabled: true,
  state: 'other',
  holder: { name: 'Edith', lastActiveAt: '2026-10-14T10:00:00.000Z' },
  canTakeOver: false,
  expiresAt: null,
};

const tree = buildNodes([
  section('s1', [column('c1', [block('h1', 'heading')])]),
  section('s2', [column('c2', [block('h2', 'heading')])]),
]);

function sessionWith(lock: LockView): EditorSession {
  return {
    pageId: 'p1',
    locale: 'en',
    pageVersion: 7,
    canDelete: true,
    columnsEnabled: true,
    lock,
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

describe('the editor store', () => {
  it('starts opening, in Edit, with nothing selected', () => {
    const state = createEditorStore().getState();
    expect(state.status).toBe('opening');
    expect(state.mode).toBe('edit');
    expect(state.selection).toEqual({ scopeId: null, selectedId: null });
    expect(state.session).toBeNull();
  });

  it('starts editing when this tab holds the page', () => {
    const store = createEditorStore();
    store.opened(sessionWith(MINE));
    const state = store.getState();
    expect(state.status).toBe('editing');
    expect(state.mode).toBe('edit');
    expect(state.pageVersion).toBe(7);
    expect(state.model?.size).toBe(tree.length);
  });

  it('shows a page another editor holds as a visitor would see it', () => {
    const store = createEditorStore();
    store.opened(sessionWith(OTHER));
    expect(store.getState().status).toBe('locked');
    expect(store.getState().mode).toBe('interact');
    store.select({ scopeId: null, selectedId: 's1' });
    expect(store.getState().selection.selectedId).toBeNull();
  });

  it('leaves the page a plain site when it cannot be opened', () => {
    const store = createEditorStore();
    store.failedToOpen('not-found');
    expect(store.getState().status).toBe('unavailable');
    expect(store.getState().mode).toBe('interact');
  });

  it('selects only in Edit and clears the selection on entering Interact', () => {
    const store = createEditorStore();
    store.opened(sessionWith(MINE));
    store.select({ scopeId: null, selectedId: 's2' });
    expect(store.getState().selection.selectedId).toBe('s2');
    store.setMode('interact');
    expect(store.getState().selection.selectedId).toBeNull();
    store.select({ scopeId: null, selectedId: 's1' });
    expect(store.getState().selection.selectedId).toBeNull();
    store.setMode('edit');
    expect(store.getState().selection.selectedId).toBeNull();
  });

  it('ends editing in this tab when another editor takes the page', () => {
    const store = createEditorStore();
    store.opened(sessionWith(MINE));
    store.select({ scopeId: null, selectedId: 's1' });
    store.setLock(MINE);
    expect(store.getState().status).toBe('editing');
    store.setLock(OTHER);
    const state = store.getState();
    expect(state.status).toBe('locked');
    expect(state.mode).toBe('interact');
    expect(state.selection.selectedId).toBeNull();
    expect(state.lock).toEqual(OTHER);
  });

  it('names the holder of a locked page and follows their last activity', () => {
    const store = createEditorStore();
    store.opened(sessionWith(OTHER));
    expect(store.getState().notice).toEqual({
      kind: 'locked',
      holderName: 'Edith',
      lastActiveAt: '2026-10-14T10:00:00.000Z',
    });
    const later = {
      ...OTHER,
      holder: { name: 'Edith', lastActiveAt: '2026-10-14T10:05:00.000Z' },
    };
    store.setLock(later);
    expect(store.getState().notice?.lastActiveAt).toBe(
      later.holder.lastActiveAt,
    );
  });

  it('drops what was pending and warns when the page is taken over', () => {
    const store = createEditorStore();
    store.opened(sessionWith(MINE));
    store.setQueue({
      ...store.getState().queue,
      entries: [
        {
          seq: 1,
          intent: { kind: 'delete', blockId: 'h1' },
          ready: true,
          fragments: false,
        },
      ],
    });
    store.setLock(OTHER);
    const state = store.getState();
    expect(state.queue.entries).toEqual([]);
    expect(state.undo.undo).toEqual([]);
    expect(state.notice).toEqual({ kind: 'taken-over', holderName: 'Edith' });
  });

  it('notifies subscribers once per change and not after unsubscribing', () => {
    const store = createEditorStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.announce('Edit mode.');
    store.announce('Edit mode.');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    store.announce('Interact mode.');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the rail drawer', () => {
  it('opens on a tab, closes, and keeps the tab the editor last looked at', () => {
    const store = createEditorStore();
    store.openDrawer('properties');
    expect(store.getState().drawer).toBe('properties');
    expect(store.getState().panelTab).toBe('properties');
    store.closeDrawer();
    expect(store.getState().drawer).toBeNull();
    expect(store.getState().panelTab).toBe('properties');
    // the notice button opens the drawer without changing the tab
    store.openDrawer('notice');
    expect(store.getState().panelTab).toBe('properties');
  });

  it('counts a notice as read once the drawer was opened or closed on it', () => {
    const store = createEditorStore();
    store.opened(sessionWith(OTHER));
    const notice = store.getState().notice;
    expect(notice).not.toBeNull();
    expect(store.getState().noticeSeen).not.toBe(notice);
    store.openDrawer('notice');
    expect(store.getState().noticeSeen).toBe(notice);
    store.setNotice({ kind: 'lapsed', holderName: 'Edith' });
    store.closeDrawer();
    expect(store.getState().noticeSeen).toBe(store.getState().notice);
  });
});

describe('announceSelection', () => {
  const model = createTreeModel(
    tree.map((node) =>
      node.id === 'h2' ? { ...node, needsInput: ['text'] } : node,
    ),
  );
  const catalogue = [
    catalogueEntry('section', 'section'),
    catalogueEntry('column', 'column'),
    catalogueEntry('heading', 'block'),
  ];

  it('announces a top-level section by its position among the sections', () => {
    const selection = selectByClick(
      model,
      { scopeId: null, selectedId: null },
      ['h2', 'c2', 's2'],
    );
    expect(announceSelection(model, catalogue, selection)).toBe(
      'Selected section, section 2 of 2.',
    );
  });

  it('names a block, its place and what it sits in, and flags missing input', () => {
    const text = announceSelection(model, catalogue, {
      scopeId: 'c2',
      selectedId: 'h2',
    });
    expect(text).toBe('Selected heading, 1 of 1 in Column 1. Needs input.');
  });

  it('says nothing for an empty selection', () => {
    expect(
      announceSelection(model, catalogue, { scopeId: null, selectedId: null }),
    ).toBe('');
  });
});
