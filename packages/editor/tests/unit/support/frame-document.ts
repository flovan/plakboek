import { EDIT_ATTRIBUTE } from '@plakboek/render';

type FakeElement = {
  readonly id: string;
  readonly parentElement: null;
  readonly parentNode: null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): null;
  after(element: FakeElement): void;
};

/**
 * A frame document holding only top-level block elements: enough for the patch
 * code to find blocks, parse a one-element fragment and add a section after the
 * last one. Unit tests run in plain Node, so there is no real DOM.
 */
export function fakeFrameDocument(rootIds: readonly string[]) {
  const roots: FakeElement[] = [];
  const element = (id: string): FakeElement => ({
    id,
    parentElement: null,
    parentNode: null,
    hasAttribute: (name) => name === EDIT_ATTRIBUTE.block,
    querySelector: () => null,
    after(next) {
      roots.splice(roots.indexOf(this) + 1, 0, next);
    },
  });
  roots.push(...rootIds.map(element));

  const frameDocument = {
    defaultView: null,
    scrollingElement: null,
    querySelector(selector: string) {
      const id = /="(.*)"\]$/.exec(selector)?.[1];
      return roots.find((root) => root.id === id) ?? null;
    },
    querySelectorAll: () => [...roots],
    createElement: () => {
      const template = {
        content: { childElementCount: 0, firstElementChild: null as unknown },
        set innerHTML(html: string) {
          const id = /="([^"]*)"/.exec(html)?.[1] ?? '';
          template.content = {
            childElementCount: 1,
            firstElementChild: element(id),
          };
        },
      };
      return template;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    document: frameDocument as unknown as Document,
    ids: () => roots.map((root) => root.id),
  };
}
