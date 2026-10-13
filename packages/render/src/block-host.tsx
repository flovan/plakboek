/**
 * The block recursion both renderers share: a published snapshot
 * (`renderPageSnapshot`) and a live working tree (`renderPageTree`) walk their
 * blocks through the same `BlockHost`, so containment behaves identically.
 *
 * Containment (D-14, D-29): a block's component is called as a plain function
 * inside `BlockHost`'s own render, so hooks keep working, and the element tree
 * it returns is rendered to a string right there, inside the same try/catch.
 * So an error raised by the block's own body AND an error raised by any
 * component it returns (a shared image, a rich-text renderer, ...) is
 * contained to that block. A block with no component renders nothing and is
 * reported; the outcome is deterministic for a tree, so the page stays
 * cacheable. A block that throws, whose output throws, or that returns a
 * promise (rendering here is synchronous) is dropped together with its
 * subtree, reported, and marks the render `degraded`. No error boundary or
 * Suspense is used: neither reports errors on this renderer.
 *
 * A contained block's markup cannot be handed back to React as raw HTML
 * without a wrapper element, so `BlockHost` returns a text sentinel made of
 * unescaped characters and the finished strings are spliced in afterwards.
 * The sentinel carries a per-render random nonce, so no block can forge one.
 *
 * What a renderer plugs in: which edit proxy a block receives, whether a node
 * is degraded (never handed to its component), and, for edit renders only, a
 * placeholder that stands in for a block that would otherwise render nothing.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentMap } from './components.js';
import type { EditProxy } from './edit-proxy.js';
import { reportRenderEvent, type RenderHooks } from './hooks.js';
import { toBlockLayout } from './layout.js';

/** The node shape both a snapshot block and a live tree node satisfy. */
export type HostNode<N> = {
  readonly id: string;
  readonly blockType: string;
  readonly schemaVersion: number;
  readonly props: unknown;
  /** The node's stored layout, when the source carries one. */
  readonly layout?: unknown;
  readonly children: readonly N[];
};

/** Why a block renders a placeholder instead of its component. */
export type PlaceholderReason = 'unknown' | 'degraded' | 'failed';

/** Render-local state: created per render call, never shared. */
type RenderState = {
  degraded: boolean;
  /** Per-render secret that makes block sentinels unforgeable. */
  readonly nonce: string;
  /** Finished markup of every contained block, by sentinel index. */
  readonly rendered: string[];
};

/** What a renderer supplies; the recursion state is added per call. */
export type HostOptions<N extends HostNode<N>> = {
  readonly components: ComponentMap;
  readonly hooks: RenderHooks | undefined;
  readonly pageId: string;
  /** The proxy a node's component receives as `edit`. */
  readonly editFor: (node: N) => EditProxy;
  /** A degraded node is never handed to its component. */
  readonly isDegraded?: (node: N) => boolean;
  /** Stands in for a block that renders nothing; absent means render nothing. */
  readonly placeholderFor?: (node: N, reason: PlaceholderReason) => ReactNode;
};

type HostContext<N extends HostNode<N>> = HostOptions<N> & {
  readonly state: RenderState;
};

type BlockHostProps<N extends HostNode<N>> = {
  readonly block: N;
  readonly context: HostContext<N>;
};

/** Wraps a promise-returning component so the report names what went wrong. */
class AsyncBlockComponentError extends Error {
  constructor() {
    super('a block component returned a promise; rendering is synchronous');
    this.name = 'AsyncBlockComponentError';
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'then') === 'function'
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NO_PROPS: Readonly<Record<string, unknown>> = Object.freeze({});

function sentinelFor(state: RenderState, index: number): string {
  return `plakboek-block-${state.nonce}-${String(index)}-end`;
}

/** Replaces every sentinel with its block's markup, nested blocks included. */
function spliceBlocks(markup: string, state: RenderState): string {
  const pattern = new RegExp(`plakboek-block-${state.nonce}-(\\d+)-end`, 'g');
  const expand = (text: string): string =>
    text.replace(pattern, (_match, index: string) =>
      expand(state.rendered[Number(index)] ?? ''),
    );
  return expand(markup);
}

/**
 * Renders one block. "No component" covers both a type the config never
 * declared and a type declared without a component.
 */
function BlockHost<N extends HostNode<N>>({
  block,
  context,
}: BlockHostProps<N>): ReactNode {
  const { components, hooks, pageId, state } = context;
  if (context.isDegraded?.(block) === true) {
    state.degraded = true;
    return context.placeholderFor?.(block, 'degraded') ?? null;
  }
  const component = components.get(block.blockType);
  if (component === undefined) {
    reportRenderEvent('onUnknownBlock', hooks?.onUnknownBlock, {
      blockType: block.blockType,
      blockId: block.id,
      pageId,
    });
    return context.placeholderFor?.(block, 'unknown') ?? null;
  }
  const children = block.children.map((child) => (
    <BlockHost<N> key={child.id} block={child} context={context} />
  ));
  try {
    const rendered: unknown = component({
      block: {
        id: block.id,
        blockType: block.blockType,
        schemaVersion: block.schemaVersion,
      },
      props: isRecord(block.props) ? block.props : NO_PROPS,
      layout: toBlockLayout(block.layout),
      children,
      edit: context.editFor(block),
    });
    if (isThenable(rendered)) {
      // Swallow the eventual rejection so it never becomes unhandled.
      Promise.resolve(rendered).catch(() => undefined);
      throw new AsyncBlockComponentError();
    }
    const html = renderToStaticMarkup(<>{rendered as ReactNode}</>);
    state.rendered.push(html);
    return sentinelFor(state, state.rendered.length - 1);
  } catch (error) {
    state.degraded = true;
    reportRenderEvent('onBlockRenderError', hooks?.onBlockRenderError, {
      blockType: block.blockType,
      blockId: block.id,
      pageId,
      error,
    });
    return context.placeholderFor?.(block, 'failed') ?? null;
  }
}

export type RenderedBlocks = {
  readonly body: string;
  /** Whether any block failed to render or was degraded. */
  readonly degraded: boolean;
};

/**
 * Renders a forest of blocks to one body string through the shared recursion.
 * ONE `renderToStaticMarkup` call renders the roots (D-28); every block, a
 * section or not, goes through the same `BlockHost` (04 D-16).
 */
export function renderBlocks<N extends HostNode<N>>(
  blocks: readonly N[],
  options: HostOptions<N>,
): RenderedBlocks {
  const state: RenderState = {
    degraded: false,
    nonce: globalThis.crypto.randomUUID().replaceAll('-', ''),
    rendered: [],
  };
  const context: HostContext<N> = { ...options, state };
  const shell = renderToStaticMarkup(
    <>
      {blocks.map((block) => (
        <BlockHost<N> key={block.id} block={block} context={context} />
      ))}
    </>,
  );
  return { body: spliceBlocks(shell, state), degraded: state.degraded };
}
