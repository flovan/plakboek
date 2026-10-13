import {
  EDIT_ATTRIBUTE,
  type BlockEditHooks,
  type BlockRevealContext,
} from '@plakboek/render';
import { describe, expect, it, vi } from 'vitest';
import { createHooksRuntime } from '../../src/client/frame/hooks-runtime.js';

type FakeElement = {
  readonly id: string;
  readonly type: string;
  readonly children: FakeElement[];
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): FakeElement[];
};

function block(
  id: string,
  type: string,
  children: FakeElement[] = [],
): FakeElement {
  const fake: FakeElement = {
    id,
    type,
    children,
    getAttribute(name) {
      if (name === EDIT_ATTRIBUTE.block) return id;
      if (name === EDIT_ATTRIBUTE.type) return type;
      return null;
    },
    querySelectorAll() {
      return flatten(children);
    },
  };
  return fake;
}

function flatten(elements: readonly FakeElement[]): FakeElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children)]);
}

/** A frame document over a block tree. `roots` is replaced to model a patch. */
function fakeDocument(roots: FakeElement[]) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const state = { roots };
  const frameDocument = {
    defaultView: { name: 'frame' },
    querySelector(selector: string) {
      const match = /="(.*)"\]$/.exec(selector);
      const id = match?.[1];
      return flatten(state.roots).find((element) => element.id === id) ?? null;
    },
    querySelectorAll() {
      return flatten(state.roots);
    },
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    state,
    document: frameDocument as unknown as Document,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    swap(ids: string[]) {
      for (const listener of listeners.get('plakboek:blocks-swapped') ?? []) {
        listener({ type: 'plakboek:blocks-swapped', detail: { ids } } as never);
      }
    },
  };
}

/** Hooks that log `<hook>:<id>` (plus the target for reveal) to one list. */
function recordingHooks(log: string[], types: string[]) {
  const hooks = new Map<string, BlockEditHooks>();
  for (const type of types) {
    hooks.set(type, {
      enter: (context) => log.push(`enter:${context.id}:${context.mode}`),
      leave: (context) => log.push(`leave:${context.id}:${context.mode}`),
      select: (context) => log.push(`select:${context.id}`),
      deselect: (context) => log.push(`deselect:${context.id}`),
      reveal: (context: BlockRevealContext) =>
        log.push(`reveal:${context.id}>${context.targetId}`),
      rendered: (context) => log.push(`rendered:${context.id}`),
    });
  }
  return hooks;
}

const tree = () => {
  const slide = block('slide', 'slide');
  const carousel = block('carousel', 'carousel', [slide]);
  const plain = block('plain', 'text');
  return [block('section', 'section', [carousel, plain])];
};

describe('createHooksRuntime lifecycle', () => {
  it('enters every hooked block once when attached in Edit, and ignores unhooked types', () => {
    const log: string[] = [];
    const frame = fakeDocument(tree());
    const runtime = createHooksRuntime({
      hooks: recordingHooks(log, ['carousel', 'slide']),
      propsOf: () => undefined,
      mode: 'edit',
    });
    runtime.attach(frame.document);
    expect(log).toEqual(['enter:carousel:edit', 'enter:slide:edit']);
  });

  it('does not enter when attached in Interact, then leaves and enters on mode changes', () => {
    const log: string[] = [];
    const frame = fakeDocument(tree());
    const runtime = createHooksRuntime({
      hooks: recordingHooks(log, ['carousel']),
      propsOf: () => undefined,
      mode: 'interact',
    });
    runtime.attach(frame.document);
    expect(log).toEqual([]);
    runtime.setMode('edit');
    runtime.setMode('interact');
    expect(log).toEqual(['enter:carousel:edit', 'leave:carousel:interact']);
  });

  it('passes the context: id, type, element, document, window and props', () => {
    const frame = fakeDocument(tree());
    const seen = vi.fn();
    const runtime = createHooksRuntime({
      hooks: new Map([['carousel', { enter: seen }]]),
      propsOf: (id) => ({ of: id }),
      mode: 'edit',
    });
    runtime.attach(frame.document);
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0]).toMatchObject({
      id: 'carousel',
      blockType: 'carousel',
      document: frame.document,
      window: { name: 'frame' },
      props: { of: 'carousel' },
      mode: 'edit',
    });
  });

  it('runs deselect, then reveal outermost first, then reveal and select on the item', () => {
    const log: string[] = [];
    const frame = fakeDocument(tree());
    const runtime = createHooksRuntime({
      hooks: recordingHooks(log, ['section', 'carousel', 'slide']),
      propsOf: () => undefined,
      mode: 'edit',
    });
    runtime.attach(frame.document);
    runtime.select('carousel', ['section']);
    log.length = 0;
    runtime.select('slide', ['section', 'carousel']);
    expect(log).toEqual([
      'deselect:carousel',
      'reveal:section>slide',
      'reveal:carousel>slide',
      'reveal:slide>slide',
      'select:slide',
    ]);
  });

  it('calls rendered then enter on a swapped block and its hooked descendants, then re-applies the selection', () => {
    const log: string[] = [];
    const frame = fakeDocument(tree());
    const runtime = createHooksRuntime({
      hooks: recordingHooks(log, ['carousel', 'slide']),
      propsOf: () => undefined,
      mode: 'edit',
    });
    runtime.attach(frame.document);
    runtime.select('slide', ['section', 'carousel']);
    log.length = 0;
    frame.swap(['carousel']);
    expect(log).toEqual([
      'rendered:carousel',
      'rendered:slide',
      'enter:carousel:edit',
      'enter:slide:edit',
      'reveal:carousel>slide',
      'reveal:slide>slide',
      'select:slide',
    ]);
  });

  it('does not re-apply a selection that lies outside the replaced block', () => {
    const log: string[] = [];
    const frame = fakeDocument(tree());
    const runtime = createHooksRuntime({
      hooks: recordingHooks(log, ['carousel', 'text']),
      propsOf: () => undefined,
      mode: 'edit',
    });
    runtime.attach(frame.document);
    runtime.select('plain', ['section']);
    log.length = 0;
    runtime.rendered(['carousel']);
    expect(log).toEqual(['rendered:carousel', 'enter:carousel:edit']);
  });

  it('skips enter after a render in Interact, and stops listening once disposed', () => {
    const log: string[] = [];
    const frame = fakeDocument(tree());
    const runtime = createHooksRuntime({
      hooks: recordingHooks(log, ['carousel']),
      propsOf: () => undefined,
      mode: 'interact',
    });
    runtime.attach(frame.document);
    frame.swap(['carousel']);
    expect(log).toEqual(['rendered:carousel']);
    runtime.dispose();
    expect(frame.listenerCount('plakboek:blocks-swapped')).toBe(0);
  });
});

describe('createHooksRuntime containment', () => {
  it('reports a throwing hook by block type and hook name once, and the following reveal still runs', () => {
    const log: string[] = [];
    const report = vi.fn();
    const frame = fakeDocument(tree());
    const hooks = new Map<string, BlockEditHooks>([
      [
        'carousel',
        {
          reveal: (context) => log.push(`reveal:${context.id}`),
          select: () => {
            throw new TypeError('secret host value');
          },
        },
      ],
      ['slide', { reveal: (context) => log.push(`reveal:${context.id}`) }],
    ]);
    const runtime = createHooksRuntime({
      hooks,
      propsOf: () => undefined,
      mode: 'edit',
      report,
    });
    runtime.attach(frame.document);
    runtime.select('carousel', ['section']);
    runtime.select('slide', ['section', 'carousel']);
    runtime.select('carousel', ['section']);
    expect(log).toEqual([
      'reveal:carousel',
      'reveal:carousel',
      'reveal:slide',
      'reveal:carousel',
    ]);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      '[@plakboek/editor] the select hook of carousel failed: TypeError',
    );
  });
});
