import type { PublishedPageView, SnapshotBlock } from '@plakboek/pages';
import { createElement, useId, useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockComponent, EditProxy } from '../../src/index.js';
import { NOOP_EDIT } from '../../src/index.js';
import type { ComponentMap } from '../../src/server.js';
import { renderPageSnapshot } from '../../src/server.js';

const PAGE_ID = 'page-1';

function block(
  id: string,
  blockType: string,
  props: Record<string, unknown> = {},
  children: readonly SnapshotBlock[] = [],
): SnapshotBlock {
  return { id, blockType, schemaVersion: 1, props, children };
}

function viewOf(blocks: readonly SnapshotBlock[]): PublishedPageView {
  return {
    page: {
      id: PAGE_ID,
      locale: 'en',
      title: 'Test page',
      resolvedPath: '/test',
      seo: {
        title: null,
        description: null,
        imageAssetId: null,
        canonicalUrl: null,
        noindex: false,
        nofollow: false,
      },
    },
    publication: {
      id: 'publication-1',
      manifestHash: 'hash',
      publishedAt: new Date('2026-09-25T09:00:00.000Z'),
      snapshot: { blocks },
    },
  };
}

const Heading: BlockComponent = ({ props }) =>
  createElement('h2', null, String(props.text));

const Section: BlockComponent = ({ children }) =>
  createElement('section', null, children);

const Boom: BlockComponent = () => {
  throw new Error('secret editor content in the message');
};

const components: ComponentMap = new Map<string, BlockComponent>([
  ['heading', Heading],
  ['section', Section],
  ['boom', Boom],
]);

function render(
  blocks: readonly SnapshotBlock[],
  options: {
    readonly components?: ComponentMap;
    readonly hooks?: Parameters<typeof renderPageSnapshot>[0]['hooks'];
  } = {},
) {
  return renderPageSnapshot({
    view: viewOf(blocks),
    publicPath: '/test',
    components: options.components ?? components,
    hooks: options.hooks,
  });
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('unknown blocks (D-14)', () => {
  it('renders nothing, reports the block, and stays cacheable', () => {
    const onUnknownBlock = vi.fn();
    const rendered = render(
      [block('b1', 'gone'), block('b2', 'heading', { text: 'Hi' })],
      {
        hooks: { onUnknownBlock },
      },
    );
    expect(rendered.body).toBe('<h2>Hi</h2>');
    expect(rendered.degraded).toBe(false);
    expect(onUnknownBlock).toHaveBeenCalledTimes(1);
    expect(onUnknownBlock).toHaveBeenCalledWith({
      blockType: 'gone',
      blockId: 'b1',
      pageId: PAGE_ID,
    });
  });
});

describe('throwing blocks (D-29)', () => {
  it('drops the throwing block, keeps its siblings and marks the render degraded', () => {
    const onBlockRenderError = vi.fn();
    const rendered = render(
      [
        block('a', 'heading', { text: 'A' }),
        block('x', 'boom'),
        block('b', 'heading', { text: 'B' }),
      ],
      { hooks: { onBlockRenderError } },
    );
    expect(rendered.body).toBe('<h2>A</h2><h2>B</h2>');
    expect(rendered.degraded).toBe(true);
    expect(onBlockRenderError).toHaveBeenCalledTimes(1);
    const event = onBlockRenderError.mock.calls[0]?.[0] as {
      blockType: string;
      blockId: string;
      pageId: string;
      error: unknown;
    };
    expect(event.blockType).toBe('boom');
    expect(event.blockId).toBe('x');
    expect(event.pageId).toBe(PAGE_ID);
    expect(event.error).toBeInstanceOf(Error);
    expect((event.error as Error).message).toContain('secret editor content');
  });

  it('drops a throwing section with its children only', () => {
    const rendered = render(
      [
        block('s1', 'section', {}, [
          block('h1', 'heading', { text: 'Inside' }),
        ]),
        block('s2', 'section', {}, [block('h2', 'heading', { text: 'Other' })]),
      ],
      {
        components: new Map<string, BlockComponent>([
          ['heading', Heading],
          [
            'section',
            ({ block: self, children }) => {
              if (self.id === 's1') throw new Error('section failed');
              return createElement('section', null, children);
            },
          ],
        ]),
        hooks: { onBlockRenderError: () => undefined },
      },
    );
    expect(rendered.body).toBe('<section><h2>Other</h2></section>');
    expect(rendered.body).not.toContain('Inside');
    expect(rendered.degraded).toBe(true);
  });

  it('contains an error raised by a component the block returns, and keeps the markup safe', () => {
    const onBlockRenderError = vi.fn();
    const Thrower = (): never => {
      throw new Error('nested failure');
    };
    const rendered = render(
      [
        block('s1', 'section', {}, [
          block('n1', 'nested'),
          block('h1', 'heading', { text: '<b>& kept</b>' }),
        ]),
      ],
      {
        components: new Map<string, BlockComponent>([
          ['heading', Heading],
          ['section', Section],
          ['nested', () => createElement('div', null, createElement(Thrower))],
        ]),
        hooks: { onBlockRenderError },
      },
    );
    expect(rendered.body).toBe(
      '<section><h2>&lt;b&gt;&amp; kept&lt;/b&gt;</h2></section>',
    );
    expect(rendered.degraded).toBe(true);
    expect(onBlockRenderError).toHaveBeenCalledTimes(1);
    expect(onBlockRenderError.mock.calls[0]?.[0]).toMatchObject({
      blockType: 'nested',
      blockId: 'n1',
    });
  });

  it('treats a component that returns a promise as a throwing block', () => {
    const onBlockRenderError = vi.fn();
    const asyncBlock = (async () =>
      createElement('p', null, 'late')) as unknown as BlockComponent;
    const rendered = render(
      [block('p1', 'async'), block('h', 'heading', { text: 'Kept' })],
      {
        components: new Map<string, BlockComponent>([
          ['heading', Heading],
          ['async', asyncBlock],
        ]),
        hooks: { onBlockRenderError },
      },
    );
    expect(rendered.body).toBe('<h2>Kept</h2>');
    expect(rendered.degraded).toBe(true);
    expect(onBlockRenderError).toHaveBeenCalledTimes(1);
    const event = onBlockRenderError.mock.calls[0]?.[0] as { error: Error };
    expect(event.error.name).toBe('AsyncBlockComponentError');
  });

  it('lets a component use hooks inside the containment', () => {
    const WithHooks: BlockComponent = ({ props }) => {
      const id = useId();
      const upper = useMemo(
        () => String(props.text).toUpperCase(),
        [props.text],
      );
      return createElement('p', { id }, upper);
    };
    const rendered = render([block('h', 'hooked', { text: 'quiet' })], {
      components: new Map<string, BlockComponent>([['hooked', WithHooks]]),
    });
    expect(rendered.body).toMatch(/^<p id="[^"]+">QUIET<\/p>$/);
    expect(rendered.degraded).toBe(false);
  });
});

describe('reporting never breaks a render', () => {
  it('survives a hook that throws and a hook that rejects', async () => {
    const spy = silenceConsole();
    try {
      const blocks = [block('x', 'boom'), block('u', 'gone')];
      const throwing = render(blocks, {
        hooks: {
          onBlockRenderError: () => {
            throw new Error('hook failed');
          },
          onUnknownBlock: () => {
            throw new Error('hook failed');
          },
        },
      });
      expect(throwing.body).toBe('');
      expect(throwing.degraded).toBe(true);

      const rejecting = render(blocks, {
        hooks: {
          onBlockRenderError: () => Promise.reject(new Error('rejected')),
          onUnknownBlock: () => Promise.reject(new Error('rejected')),
        } as never,
      });
      expect(rejecting.body).toBe('');
      expect(rejecting.degraded).toBe(true);
      // Let the contained rejections settle without surfacing.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      spy.mockRestore();
    }
  });

  it('logs ids and the error name, never the error message, without a hook', () => {
    const spy = silenceConsole();
    try {
      render([block('x', 'boom'), block('u', 'gone')]);
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain('boom');
      expect(logged).toContain('"x"');
      expect(logged).toContain('gone');
      expect(logged).toContain(PAGE_ID);
      expect(logged).toContain('"error":"Error"');
      expect(logged).not.toContain('secret editor content');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the edit proxy on a visitor page (D-15)', () => {
  it('hands every component the one shared NOOP_EDIT and spreads no attribute', () => {
    const seen: EditProxy[] = [];
    const Spreading: BlockComponent = ({ edit, children }) => {
      seen.push(edit);
      return createElement(
        'div',
        { ...edit },
        createElement('span', { ...edit.field('text') }, 'text'),
        children,
      );
    };
    const rendered = render(
      [block('a', 'spread', {}, [block('b', 'spread')]), block('c', 'spread')],
      { components: new Map<string, BlockComponent>([['spread', Spreading]]) },
    );
    expect(seen).toHaveLength(3);
    for (const edit of seen) expect(edit).toBe(NOOP_EDIT);
    expect(rendered.body).not.toMatch(/data-/);
    expect(rendered.body).toContain('<div><span>text</span>');
  });
});
