import type { BlockNode } from '@plakboek/pages';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockComponent } from '../../src/block-component.js';
import { ColumnBlock } from '../../src/column-block.js';
import type { ComponentMap } from '../../src/components.js';
import { renderBlockFragments } from '../../src/render-fragment.js';
import { renderPageTree, type BlockMeta } from '../../src/render-tree.js';

const PAGE_ID = 'page-1';
const NOW = new Date('2026-10-10T09:00:00.000Z');

function node(
  id: string,
  blockType: string,
  props: Record<string, unknown> = {},
  children: readonly BlockNode[] = [],
): BlockNode {
  return {
    id,
    ownerType: 'page',
    ownerId: PAGE_ID,
    locale: 'en',
    parentBlockId: null,
    blockType,
    props,
    layout: null,
    schemaVersion: 1,
    depth: 0,
    sortOrder: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    children,
    degraded: false,
  };
}

const Section: BlockComponent = ({ children, edit }) =>
  createElement('section', { ...edit }, children);

const Heading: BlockComponent = ({ props, edit }) =>
  createElement('h2', { ...edit }, String(props.text));

const Boom: BlockComponent = () => {
  throw new Error('secret editor content in the message');
};

const components: ComponentMap = new Map<string, BlockComponent>([
  ['section', Section],
  ['column', ColumnBlock],
  ['heading', Heading],
  ['boom', Boom],
]);

const blockMeta: ReadonlyMap<string, BlockMeta> = new Map([
  ['section', { label: 'Section', kind: 'section' }],
  ['column', { label: 'Column', kind: 'column' }],
  ['heading', { label: 'Heading', kind: 'block' }],
]);

const tree: readonly BlockNode[] = [
  node('s1', 'section', {}, [
    node('c1', 'column', {}, [
      node('h1', 'heading', { text: 'One' }),
      node('t1', 'heading', { text: 'Two' }),
    ]),
  ]),
];

function fragments(targets: readonly string[], blocks = tree) {
  return renderBlockFragments({
    blocks,
    targets,
    components,
    blockMeta,
    pageId: PAGE_ID,
  });
}

function frameBody(blocks: readonly BlockNode[]): string {
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
    mode: 'live',
  }).body;
}

describe('renderBlockFragments', () => {
  it('renders a block exactly as the frame shows it', () => {
    const body = frameBody(tree);
    const result = fragments(['h1', 's1']);
    expect(result.missing).toEqual([]);
    expect(result.degraded).toBe(false);
    const [heading, section] = result.fragments;
    expect(heading?.id).toBe('h1');
    expect(body).toContain(heading?.html);
    expect(section?.html).toBe(body);
  });

  it('carries the column kind on a column fragment', () => {
    const [column] = fragments(['c1']).fragments;
    expect(column?.html).toContain('data-pk-kind="column"');
    expect(column?.html).toContain('data-pk-block="h1"');
  });

  it('lists an id that is not in the tree instead of throwing', () => {
    const result = fragments(['nope', 'h1']);
    expect(result.missing).toEqual(['nope']);
    expect(result.fragments.map((fragment) => fragment.id)).toEqual(['h1']);
  });

  it('turns a throwing block into the placeholder the frame shows', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = [node('s1', 'section', {}, [node('b1', 'boom')])];
    const result = fragments(['b1'], broken);
    expect(result.degraded).toBe(true);
    expect(result.fragments[0]?.html).toContain('data-pk-unavailable="failed"');
    expect(frameBody(broken)).toContain(result.fragments[0]?.html);
  });
});
