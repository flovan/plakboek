import { EDIT_ATTRIBUTE } from '@plakboek/render';
import { describe, expect, it } from 'vitest';
import { hitChain } from '../../src/client/frame/hit-test.js';

type FakeElement = {
  nodeType: 1;
  parentElement: FakeElement | null;
  attributes: Record<string, string>;
  rect: { width: number; height: number };
  display: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  closest(selector: string): FakeElement | null;
};

function element(options: {
  id?: string;
  parent?: FakeElement | null;
  width?: number;
  height?: number;
  display?: string;
}): FakeElement {
  const fake: FakeElement = {
    nodeType: 1,
    parentElement: options.parent ?? null,
    attributes:
      options.id === undefined ? {} : { [EDIT_ATTRIBUTE.block]: options.id },
    rect: { width: options.width ?? 100, height: options.height ?? 20 },
    display: options.display ?? 'block',
    getAttribute(name) {
      return fake.attributes[name] ?? null;
    },
    getBoundingClientRect() {
      return fake.rect;
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

function documentAt(hit: FakeElement | null): Document {
  const doc = {
    elementFromPoint: () => hit,
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
