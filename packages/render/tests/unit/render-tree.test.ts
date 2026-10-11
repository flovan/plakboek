import type { BlockNode } from '@plakboek/pages';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockComponent } from '../../src/block-component.js';
import type { ComponentMap } from '../../src/components.js';
import { renderPageTree, type BlockMeta } from '../../src/render-tree.js';

const PAGE_ID = 'page-1';
const NOW = new Date('2026-10-10T09:00:00.000Z');

function node(
  id: string,
  blockType: string,
  props: Record<string, unknown> = {},
  children: readonly BlockNode[] = [],
  degradedReason?: string,
): BlockNode {
  const record = {
    id,
    ownerType: 'page' as const,
    ownerId: PAGE_ID,
    locale: 'en',
    parentBlockId: null,
    blockType,
    props,
    schemaVersion: 1,
    depth: 0,
    sortOrder: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    children,
  };
  return degradedReason === undefined
    ? { ...record, degraded: false }
    : { ...record, degraded: true, degradedReason };
}

const Section: BlockComponent = ({ children, edit }) =>
  createElement('section', { ...edit }, children);

const Heading: BlockComponent = ({ props, edit }) =>
  createElement(
    'h2',
    { ...edit },
    createElement('span', { ...edit.field('text') }, String(props.text)),
  );

const Boom: BlockComponent = () => {
  throw new Error('secret editor content in the message');
};

const Later: BlockComponent = () => Promise.resolve(null) as never;

const components: ComponentMap = new Map<string, BlockComponent>([
  ['section', Section],
  ['heading', Heading],
  ['boom', Boom],
  ['later', Later],
]);

const blockMeta: ReadonlyMap<string, BlockMeta> = new Map([
  ['section', { label: 'Section', kind: 'section' }],
  ['heading', { label: 'Heading', kind: 'block' }],
]);

function render(
  blocks: readonly BlockNode[],
  mode: 'live' | 'plain' = 'live',
  hooks?: Parameters<typeof renderPageTree>[0]['hooks'],
) {
  return renderPageTree({
    page: {
      id: PAGE_ID,
      locale: 'en',
      title: 'Test page',
      seo: {
        title: null,
        description: null,
        imageAssetId: null,
        canonicalUrl: null,
        noindex: false,
        nofollow: false,
      },
    },
    blocks,
    publicPath: '/test',
    components,
    blockMeta,
    mode,
    hooks,
  });
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('live mode attributes', () => {
  const tree = [
    node('s1', 'section', {}, [
      node('h1', 'heading', { text: 'One' }),
      node('h2', 'heading', { text: 'Two' }),
    ]),
  ];

  it('spreads the attributes on each root element', () => {
    const { body, degraded } = render(tree);
    expect(degraded).toBe(false);
    expect(body).toContain(
      '<section data-pk-block="s1" data-pk-type="section" data-pk-kind="section" data-pk-label="Section">',
    );
    expect(body).toContain('data-pk-block="h1"');
    expect(body).toContain('data-pk-block="h2"');
    expect(body).toContain('data-pk-label="Heading"');
    expect(body).toContain('data-pk-kind="block"');
  });

  it('renders edit.field as data-pk-field and never spreads field itself', () => {
    const { body } = render(tree);
    expect(body).toContain('data-pk-field="text"');
    expect(body.match(/data-pk-field=/g)).toHaveLength(2);
  });

  it('falls back to the type key when blockMeta has no entry', () => {
    const { body } = renderPageTree({
      page: {
        id: PAGE_ID,
        locale: 'en',
        title: 'T',
        seo: {
          title: null,
          description: null,
          imageAssetId: null,
          canonicalUrl: null,
          noindex: false,
          nofollow: false,
        },
      },
      blocks: [node('h1', 'heading', { text: 'x' })],
      publicPath: '/test',
      components,
      blockMeta: new Map(),
      mode: 'live',
    });
    expect(body).toContain('data-pk-label="heading"');
    expect(body).toContain('data-pk-kind="block"');
  });

  it('adds no wrapper element the components did not render', () => {
    const { body } = render(tree);
    expect(body.startsWith('<section ')).toBe(true);
    expect(body.endsWith('</section>')).toBe(true);
    expect(body.match(/<div/g)).toBeNull();
    expect(body.match(/<section/g)).toHaveLength(1);
  });

  it('escapes hostile values in attributes and text', () => {
    const { body } = render([
      node('"><img src=x onerror=alert(1)>', 'heading', {
        text: '<script>alert(1)</script>',
      }),
    ]);
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<script>');
  });
});

describe('placeholders (live)', () => {
  it('contains a throwing child and renders its siblings', () => {
    const consoleError = silenceConsole();
    const onBlockRenderError = vi.fn();
    const { body, degraded } = render(
      [
        node('s1', 'section', {}, [
          node('h1', 'heading', { text: 'Before' }),
          node('b1', 'boom'),
          node('h2', 'heading', { text: 'After' }),
        ]),
      ],
      'live',
      { onBlockRenderError },
    );
    expect(degraded).toBe(true);
    expect(body).toContain('Before');
    expect(body).toContain('After');
    expect(body).toContain('data-pk-block="b1"');
    expect(body).toContain('data-pk-unavailable="failed"');
    expect(body).not.toContain('secret editor content');
    expect(onBlockRenderError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('shows a placeholder for an async component', () => {
    const consoleError = silenceConsole();
    const { body, degraded } = render([node('l1', 'later')]);
    expect(degraded).toBe(true);
    expect(body).toContain('data-pk-block="l1"');
    expect(body).toContain('data-pk-unavailable="failed"');
    consoleError.mockRestore();
  });

  it('shows a placeholder for an unknown type, carrying the type key', () => {
    const consoleError = silenceConsole();
    const onUnknownBlock = vi.fn();
    const { body } = render([node('x1', 'mystery')], 'live', {
      onUnknownBlock,
    });
    expect(body).toBe(
      '<div data-pk-block="x1" data-pk-type="mystery" data-pk-kind="block" data-pk-label="mystery" data-pk-unavailable="unknown" style="min-height:40px"></div>',
    );
    expect(onUnknownBlock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('shows a placeholder for a degraded node without calling its component', () => {
    const heading = vi.fn(Heading);
    const { body, degraded } = renderPageTree({
      page: {
        id: PAGE_ID,
        locale: 'en',
        title: 'T',
        seo: {
          title: null,
          description: null,
          imageAssetId: null,
          canonicalUrl: null,
          noindex: false,
          nofollow: false,
        },
      },
      blocks: [node('d1', 'heading', { text: 'Old' }, [], 'below-floor')],
      publicPath: '/test',
      components: new Map([['heading', heading]]),
      blockMeta,
      mode: 'live',
    });
    expect(heading).not.toHaveBeenCalled();
    expect(degraded).toBe(true);
    expect(body).toContain('data-pk-block="d1"');
    expect(body).toContain('data-pk-unavailable="degraded"');
    expect(body).not.toContain('Old');
  });

  it('keeps the kind and label of a known type on its placeholder, whatever the reason', () => {
    const consoleError = silenceConsole();
    const failing = new Map(components).set('section', Boom);
    const input = {
      page: {
        id: PAGE_ID,
        locale: 'en',
        title: 'T',
        seo: {
          title: null,
          description: null,
          imageAssetId: null,
          canonicalUrl: null,
          noindex: false,
          nofollow: false,
        },
      },
      publicPath: '/test',
      blockMeta,
      mode: 'live' as const,
    };
    const thrown = renderPageTree({
      ...input,
      components: failing,
      blocks: [node('s1', 'section')],
    });
    expect(thrown.body).toBe(
      '<div data-pk-block="s1" data-pk-type="section" data-pk-kind="section" data-pk-label="Section" data-pk-unavailable="failed" style="min-height:40px"></div>',
    );
    const degraded = renderPageTree({
      ...input,
      components,
      blocks: [node('s2', 'section', {}, [], 'below-floor')],
    });
    expect(degraded.body).toContain('data-pk-kind="section"');
    expect(degraded.body).toContain('data-pk-label="Section"');
    expect(degraded.body).toContain('data-pk-unavailable="degraded"');
    consoleError.mockRestore();
  });

  it('drops the subtree of a failing block', () => {
    const consoleError = silenceConsole();
    const { body } = render([
      node('b1', 'boom', {}, [node('h1', 'heading', { text: 'Hidden' })]),
    ]);
    expect(body).not.toContain('Hidden');
    expect(body).toContain('data-pk-block="b1"');
    consoleError.mockRestore();
  });
});

describe('plain mode', () => {
  it('renders no data-pk attribute and no placeholder', () => {
    const consoleError = silenceConsole();
    const { body, degraded } = render(
      [
        node('s1', 'section', {}, [
          node('h1', 'heading', { text: 'Visible' }),
          node('b1', 'boom'),
          node('x1', 'mystery'),
          node('d1', 'heading', { text: 'Old' }, [], 'below-floor'),
        ]),
      ],
      'plain',
    );
    expect(body).toBe('<section><h2><span>Visible</span></h2></section>');
    expect(body).not.toContain('data-pk-');
    expect(degraded).toBe(true);
    consoleError.mockRestore();
  });
});
