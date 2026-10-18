import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { describe, expect, it } from 'vitest';
import { blocksAt, hitChain } from '../../src/client/frame/hit-test.js';

type FakeElement = {
  nodeType: 1;
  parentElement: FakeElement | null;
  attributes: Record<string, string>;
  rect: { left: number; top: number; width: number; height: number };
  display: string;
  rects: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  getClientRects(): { length: number };
  closest(selector: string): FakeElement | null;
};

function element(options: {
  id?: string;
  parent?: FakeElement | null;
  width?: number;
  height?: number;
  display?: string;
  left?: number;
  top?: number;
  rects?: number;
}): FakeElement {
  const fake: FakeElement = {
    nodeType: 1,
    parentElement: options.parent ?? null,
    attributes:
      options.id === undefined ? {} : { [EDIT_ATTRIBUTE.block]: options.id },
    rect: {
      left: options.left ?? 0,
      top: options.top ?? 0,
      width: options.width ?? 100,
      height: options.height ?? 20,
    },
    display: options.display ?? 'block',
    rects: options.rects ?? 1,
    getAttribute(name) {
      return fake.attributes[name] ?? null;
    },
    getBoundingClientRect() {
      return fake.rect;
    },
    getClientRects() {
      return { length: fake.rects };
    },
    closest(selector) {
      // The only selector in use is `[data-pk-block]`.
      expect(selector).toBe(`[${EDIT_ATTRIBUTE.block}]`);
      let current: FakeElement | null = fake;
      while (current !== null) {
        if (EDIT_ATTRIBUTE.block in current.attributes) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  return fake;
}

function documentAt(
  hit: FakeElement | null,
  all: readonly FakeElement[] = [],
): Document {
  const doc = {
    elementFromPoint: () => hit,
    querySelectorAll: (selector: string) => {
      expect(selector).toBe(`[${EDIT_ATTRIBUTE.block}]`);
      return all.filter((entry) => EDIT_ATTRIBUTE.block in entry.attributes);
    },
    defaultView: {
      getComputedStyle: (target: FakeElement) => ({ display: target.display }),
    },
  };
  return doc as unknown as Document;
}

describe('hitChain', () => {
  it('lists the blocks under the point, innermost first', () => {
    const section = element({ id: 'section' });
    const column = element({ id: 'column', parent: section });
    const text = element({ id: 'text', parent: column });
    const span = element({ parent: text });
    expect(hitChain(documentAt(span), 5, 5)).toEqual([
      'text',
      'column',
      'section',
    ]);
  });

  it('skips a block with no size', () => {
    const section = element({ id: 'section' });
    const column = element({ id: 'column', parent: section, width: 0 });
    const text = element({ id: 'text', parent: column });
    expect(hitChain(documentAt(text), 5, 5)).toEqual(['text', 'section']);
  });

  it('skips a display: contents wrapper', () => {
    const section = element({ id: 'section' });
    const wrapper = element({
      id: 'wrapper',
      parent: section,
      display: 'contents',
      width: 0,
      height: 0,
    });
    const text = element({ id: 'text', parent: wrapper });
    expect(hitChain(documentAt(text), 5, 5)).toEqual(['text', 'section']);
  });

  it('passes over elements between blocks that carry no block id', () => {
    const section = element({ id: 'section' });
    const plain = element({ parent: section });
    const text = element({ id: 'text', parent: plain });
    expect(hitChain(documentAt(text), 5, 5)).toEqual(['text', 'section']);
  });

  it('is empty when nothing is under the point or it is outside any block', () => {
    expect(hitChain(documentAt(null), 5, 5)).toEqual([]);
    expect(hitChain(documentAt(element({})), 5, 5)).toEqual([]);
  });
});

describe('hitChain with ghost boxes', () => {
  // A section holds a column, which holds a sized heading and an empty text
  // whose paragraph is 0px high at (10, 100): its ghost box is 24px square.
  function scene(emptyOptions: Parameters<typeof element>[0] = {}): {
    doc: (hit: FakeElement | null) => Document;
    column: FakeElement;
    empty: FakeElement;
  } {
    const section = element({ id: 'section', height: 400 });
    const column = element({ id: 'column', parent: section, height: 300 });
    const heading = element({ id: 'heading', parent: column });
    const empty = element({
      id: 'empty',
      parent: column,
      left: 10,
      top: 100,
      width: 200,
      height: 0,
      ...emptyOptions,
    });
    const all = [section, column, heading, empty];
    return { doc: (hit) => documentAt(hit, all), column, empty };
  }

  it('puts a zero-height block first in the chain where its ghost box holds the point', () => {
    const { doc, column } = scene();
    expect(hitChain(doc(column), 40, 108)).toEqual([
      'empty',
      'column',
      'section',
    ]);
  });

  it('hits a zero-width block the same way', () => {
    const { doc, column } = scene({ width: 0, height: 20 });
    expect(hitChain(doc(column), 20, 105)).toEqual([
      'empty',
      'column',
      'section',
    ]);
  });

  it('gives the strict chain below the ghost box', () => {
    const { doc, column } = scene();
    expect(hitChain(doc(column), 40, 130)).toEqual(['column', 'section']);
  });

  it('never makes a ghost of display: contents or of an element with no client rects', () => {
    const contents = scene({ display: 'contents', width: 0, height: 0 });
    expect(hitChain(contents.doc(contents.column), 40, 108)).toEqual([
      'column',
      'section',
    ]);
    const hidden = scene({ rects: 0 });
    expect(hitChain(hidden.doc(hidden.column), 40, 108)).toEqual([
      'column',
      'section',
    ]);
  });

  it('ignores a ghost whose parent block is not in the strict chain', () => {
    const { doc } = scene();
    const cover = element({ id: 'cover', height: 500 });
    expect(hitChain(doc(cover), 40, 108)).toEqual(['cover']);
  });

  it('picks the deeper ghost, and the later one on a tie', () => {
    const section = element({ id: 'section', height: 400 });
    const column = element({ id: 'column', parent: section, height: 300 });
    const shallow = element({
      id: 'shallow',
      parent: section,
      left: 10,
      top: 100,
      height: 0,
    });
    const deep = element({
      id: 'deep',
      parent: column,
      left: 10,
      top: 100,
      height: 0,
    });
    const later = element({
      id: 'later',
      parent: column,
      left: 10,
      top: 100,
      height: 0,
    });
    const all = [section, column, shallow, deep, later];
    expect(hitChain(documentAt(column, all), 40, 108)[0]).toBe('later');
    expect(
      hitChain(
        documentAt(column, [section, column, shallow, deep]),
        40,
        108,
      )[0],
    ).toBe('deep');
  });

  it('returns the strict chain exactly as before with ghosts off', () => {
    const { doc, column } = scene();
    expect(hitChain(doc(column), 40, 108, { ghosts: false })).toEqual([
      'column',
      'section',
    ]);
  });

  it('blocksAt returns the elements the ids come from', () => {
    const { doc, column, empty } = scene();
    expect(blocksAt(doc(column), 40, 108)[0]).toBe(empty);
  });
});
