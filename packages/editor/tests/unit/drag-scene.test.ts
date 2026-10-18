import { describe, expect, it } from 'vitest';
import { createSceneReader } from '../../src/client/drag/scene.js';
import { createTreeModel } from '../../src/client/session/tree-model.js';
import { block, buildNodes, column, section } from './support/model.js';

const model = createTreeModel(
  buildNodes([section('s1', [column('c1', [block('h1', 'heading')])])]),
);

/** A frame whose window and document are just enough for the scene reader to measure nothing. */
function fakeFrame() {
  const makeWindow = () => {
    const listeners = new Map<string, Set<unknown>>();
    const view = {
      listeners,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ display: 'block', position: 'static' }),
      addEventListener: (type: string, listener: unknown) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: unknown) => {
        listeners.get(type)?.delete(listener);
      },
      document: null as unknown,
    };
    return view;
  };
  const makeDocument = (view: ReturnType<typeof makeWindow>) => {
    const doc = {
      URL: 'http://site.test/',
      defaultView: view,
      querySelectorAll: () => [],
    };
    view.document = doc;
    return doc;
  };
  const state = { view: makeWindow() };
  const frame = {
    clientWidth: 800,
    clientHeight: 600,
    contentDocument: makeDocument(state.view),
    contentWindow: state.view,
  };
  return {
    frame: frame as unknown as HTMLIFrameElement,
    scrollTo: (y: number) => {
      state.view.scrollY = y;
    },
    /** The frame navigated: a new window and document. */
    reload: () => {
      state.view = makeWindow();
      frame.contentDocument = makeDocument(state.view);
      frame.contentWindow = state.view;
    },
    /** Listeners of a type on the window the frame shows now, or on an earlier one. */
    listenerCount: (type: string, view = state.view) =>
      view.listeners.get(type)?.size ?? 0,
    window: () => state.view,
  };
}

describe('createSceneReader', () => {
  it('measures again when the frame scrolled, even before its scroll event arrived', () => {
    const fake = fakeFrame();
    const reader = createSceneReader(fake.frame, () => model);
    const first = reader.read();
    expect(first).not.toBeNull();
    // nothing changed: the same scene
    expect(reader.read()).toBe(first);

    // the drag's auto-scroll moved the frame; no scroll event has fired yet
    fake.scrollTo(240);
    const second = reader.read();
    expect(second).not.toBe(first);
    expect(reader.read()).toBe(second);
  });

  it('follows a reloaded frame instead of listening on the old window', () => {
    const fake = fakeFrame();
    const reader = createSceneReader(fake.frame, () => model);
    const first = reader.read();
    const old = fake.window();
    expect(fake.listenerCount('scroll', old)).toBe(1);

    fake.reload();
    const second = reader.read();
    expect(second).not.toBe(first);
    // the old window's listeners are gone and the new window's are in
    expect(fake.listenerCount('scroll', old)).toBe(0);
    expect(fake.listenerCount('scroll')).toBe(1);
    expect(fake.listenerCount('resize')).toBe(1);

    reader.dispose();
    expect(fake.listenerCount('scroll')).toBe(0);
    expect(fake.listenerCount('resize')).toBe(0);
  });
});
