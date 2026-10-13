import type { BlockNode } from '@plakboek/pages';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderBlocks } from '../../src/block-host.js';
import type { BlockComponent } from '../../src/block-component.js';
import { ColumnBlock } from '../../src/column-block.js';
import type { ComponentMap } from '../../src/components.js';
import { Columns, columnTracks } from '../../src/columns.js';
import { NOOP_EDIT } from '../../src/edit-proxy.js';
import { toBlockLayout } from '../../src/layout.js';
import { renderPageTree, type BlockMeta } from '../../src/render-tree.js';

describe('columnTracks', () => {
  it('weights the tracks by a ratio with one term per column', () => {
    expect(columnTracks('2:1', 2)).toBe('minmax(0, 2fr) minmax(0, 1fr)');
    expect(columnTracks('1:2:1', 3)).toBe(
      'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)',
    );
  });

  it('falls back to equal tracks when the term count differs from the live count', () => {
    expect(columnTracks('2:1', 3)).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('falls back to one equal track for zero or one column without a match', () => {
    expect(columnTracks(undefined, 0)).toBe('minmax(0, 1fr)');
    expect(columnTracks('2:1', 0)).toBe('minmax(0, 1fr)');
    expect(columnTracks(undefined, 1)).toBe('minmax(0, 1fr)');
  });

  it.each(['1fr; background: url(x)', '0:1', '1000:1', '2:', ':2', 'a:b', ''])(
    'never emits a ratio that is not digits joined by colons (%j)',
    (ratio) => {
      expect(columnTracks(ratio, 2)).toBe('repeat(2, minmax(0, 1fr))');
    },
  );
});

describe('toBlockLayout', () => {
  it('keeps only the three known, well-typed fields', () => {
    expect(
      toBlockLayout({ columns: '1:2', align: 'center', fill: true, extra: 1 }),
    ).toEqual({ columns: '1:2', align: 'center', fill: true });
    expect(
      toBlockLayout({ align: 'sideways', fill: 'yes', columns: 4 }),
    ).toEqual({});
  });

  it('returns one frozen empty object for anything that is not a record', () => {
    expect(toBlockLayout(undefined)).toBe(toBlockLayout(null));
    expect(toBlockLayout([])).toBe(toBlockLayout('x'));
    expect(Object.isFrozen(toBlockLayout(undefined))).toBe(true);
    expect(Object.isFrozen(toBlockLayout({ fill: true }))).toBe(true);
  });
});

describe('Columns', () => {
  const cells = [
    createElement('i', { key: 'a' }),
    createElement('i', { key: 'b' }),
  ];
  const render = (layout: Parameters<typeof Columns>[0]['layout']): string =>
    renderToStaticMarkup(createElement(Columns, { layout, children: cells }));

  it('renders one grid reading the stack token, the ratio tracks and the gap token', () => {
    const html = render({ columns: '2:1' });
    expect(html).toContain('data-plakboek-columns="2"');
    expect(html).toContain('display:grid');
    expect(html).toContain(
      '--plakboek-columns-tracks:minmax(0, 2fr) minmax(0, 1fr)',
    );
    expect(html).toContain(
      'grid-template-columns:var(--plakboek-columns-stack, var(--plakboek-columns-tracks))',
    );
    expect(html).toContain('gap:var(--plakboek-column-gap, 24px)');
  });

  it('stretches by default and maps align to align-items', () => {
    expect(render({})).toContain('align-items:stretch');
    expect(render({ align: 'start' })).toContain('align-items:start');
    expect(render({ align: 'center' })).toContain('align-items:center');
    expect(render({ align: 'end' })).toContain('align-items:end');
  });
});

describe('a section rendered through the host recursion', () => {
  type Node = {
    readonly id: string;
    readonly blockType: string;
    readonly schemaVersion: number;
    readonly props: unknown;
    readonly layout?: unknown;
    readonly children: readonly Node[];
  };
  const make = (
    id: string,
    blockType: string,
    layout: unknown,
    children: readonly Node[] = [],
  ): Node => ({ id, blockType, schemaVersion: 1, props: {}, layout, children });

  const Section: BlockComponent = ({ layout, children }) =>
    createElement(
      'section',
      null,
      createElement(Columns, { layout, children }),
    );
  const Text: BlockComponent = ({ layout }) =>
    createElement('p', { 'data-layout': JSON.stringify(layout) });
  const components: ComponentMap = new Map<string, BlockComponent>([
    ['section', Section],
    ['column', ColumnBlock],
    ['text', Text],
  ]);

  it('lays the columns out on the stored ratio', () => {
    const { body, degraded } = renderBlocks(
      [
        make('s', 'section', { columns: '1:2' }, [
          make('c1', 'column', undefined),
          make('c2', 'column', undefined),
        ]),
      ],
      { components, hooks: undefined, pageId: 'p', editFor: () => NOOP_EDIT },
    );
    expect(degraded).toBe(false);
    expect(body).toContain('minmax(0, 1fr) minmax(0, 2fr)');
  });

  it('passes the layout to every block and keeps it out of props', () => {
    const { body } = renderBlocks(
      [make('t', 'text', { fill: true, columns: 7 })],
      { components, hooks: undefined, pageId: 'p', editFor: () => NOOP_EDIT },
    );
    expect(body).toContain('data-layout="{&quot;fill&quot;:true}"');
    const empty = renderBlocks([make('t', 'text', undefined)], {
      components,
      hooks: undefined,
      pageId: 'p',
      editFor: () => NOOP_EDIT,
    });
    expect(empty.body).toContain('data-layout="{}"');
  });
});

describe('the column cell in an edit render', () => {
  const NOW = new Date('2026-10-13T09:00:00.000Z');
  function node(
    id: string,
    blockType: string,
    children: readonly BlockNode[] = [],
  ): BlockNode {
    return {
      id,
      ownerType: 'page',
      ownerId: 'page-1',
      locale: 'en',
      parentBlockId: null,
      blockType,
      props: {},
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
  const Text: BlockComponent = ({ edit }) => createElement('p', { ...edit });
  const components: ComponentMap = new Map<string, BlockComponent>([
    ['section', Section],
    ['column', ColumnBlock],
    ['text', Text],
  ]);
  const blockMeta: ReadonlyMap<string, BlockMeta> = new Map([
    ['section', { label: 'Section', kind: 'section' }],
    ['column', { label: 'Column', kind: 'column' }],
    ['text', { label: 'Text', kind: 'block' }],
  ]);
  const render = (mode: 'live' | 'plain'): string =>
    renderPageTree({
      page: {
        id: 'page-1',
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
      blocks: [
        node('s', 'section', [
          node('c1', 'column'),
          node('c2', 'column', [node('t', 'text')]),
        ]),
      ],
      publicPath: '/t',
      components,
      blockMeta,
      mode,
    }).body;

  it('marks an empty column and gives it a minimum height, only in a live render', () => {
    const live = render('live');
    expect(live).toContain('data-pk-kind="column"');
    expect(live.match(/data-pk-empty/g)).toHaveLength(1);
    expect(live).toContain('min-height:96px');
  });

  it('adds nothing beyond the grid cell in a visitor-style render', () => {
    const plain = render('plain');
    expect(plain).not.toContain('data-pk-');
    expect(plain).not.toContain('min-height');
    expect(plain).toContain('display:flex;flex-direction:column;min-width:0');
  });
});
