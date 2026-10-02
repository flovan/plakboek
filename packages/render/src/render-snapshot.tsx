/**
 * Server-only React walk of a published snapshot into a head and a body.
 *
 * The body is ONE `renderToStaticMarkup` call (D-28): every block, section
 * or not, goes through the same `BlockHost` recursion (04 D-16), so no
 * branch on a block's `kind` exists here.
 *
 * Containment (D-14, D-29): a block's component is called as a plain function
 * inside `BlockHost`'s own render, so hooks keep working, and that one call
 * is wrapped in a try/catch. A block with no component renders nothing and
 * is reported; the outcome is deterministic for a snapshot, so the page stays
 * cacheable. A block that throws, or returns a promise (rendering here is
 * synchronous), is dropped together with its subtree, reported, and marks the
 * render `degraded` so the handler serves it uncached. No error boundary or
 * Suspense is used: neither reports errors on this renderer. An error raised
 * by an element a block returns sits outside the inline guard and fails the
 * whole render, which the handler turns into a 500 that is never cached.
 */
import { GLOBAL_TAG, pageTag } from '@plakboek/cache';
import type { PublishedPageView, SnapshotBlock } from '@plakboek/pages';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOOP_EDIT } from './edit-proxy.js';
import type { ComponentMap } from './components.js';
import { buildPageHead, type PageHead } from './head.js';
import { reportRenderEvent, type RenderHooks } from './hooks.js';

export type RenderPageSnapshotInput = {
  readonly view: PublishedPageView;
  readonly publicPath: string;
  readonly components: ComponentMap;
  readonly hooks?: RenderHooks;
  readonly siteUrl?: string;
  readonly resolveAssetUrl?: (assetId: string) => string | null;
};

export type RenderedPage = {
  readonly head: PageHead;
  readonly body: string;
  /** Every cache tag the rendered page depends on. */
  readonly tags: readonly string[];
  /** Whether any block failed to render; a degraded page is not cached. */
  readonly degraded: boolean;
};

/** Render-local state: created per `renderPageSnapshot` call, never shared. */
type RenderState = { degraded: boolean };

type BlockHostProps = {
  readonly block: SnapshotBlock;
  readonly components: ComponentMap;
  readonly hooks: RenderHooks | undefined;
  readonly pageId: string;
  readonly state: RenderState;
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

/**
 * Renders one block. "No component" covers both a type the config never
 * declared and a type declared without a component.
 */
function BlockHost({
  block,
  components,
  hooks,
  pageId,
  state,
}: BlockHostProps): ReactNode {
  const component = components.get(block.blockType);
  if (component === undefined) {
    reportRenderEvent('onUnknownBlock', hooks?.onUnknownBlock, {
      blockType: block.blockType,
      blockId: block.id,
      pageId,
    });
    return null;
  }
  const children = block.children.map((child) => (
    <BlockHost
      key={child.id}
      block={child}
      components={components}
      hooks={hooks}
      pageId={pageId}
      state={state}
    />
  ));
  try {
    const rendered: unknown = component({
      block: {
        id: block.id,
        blockType: block.blockType,
        schemaVersion: block.schemaVersion,
      },
      props: block.props,
      children,
      edit: NOOP_EDIT,
    });
    if (isThenable(rendered)) {
      // Swallow the eventual rejection so it never becomes unhandled.
      Promise.resolve(rendered).catch(() => undefined);
      throw new AsyncBlockComponentError();
    }
    return rendered as ReactNode;
  } catch (error) {
    state.degraded = true;
    reportRenderEvent('onBlockRenderError', hooks?.onBlockRenderError, {
      blockType: block.blockType,
      blockId: block.id,
      pageId,
      error,
    });
    return null;
  }
}

/** Renders a published page's snapshot; never touches the database. */
export function renderPageSnapshot(
  input: RenderPageSnapshotInput,
): RenderedPage {
  const { view, components, hooks } = input;
  const state: RenderState = { degraded: false };
  const pageId = view.page.id;
  const head = buildPageHead({
    lang: view.page.locale,
    pageTitle: view.page.title,
    seo: view.page.seo,
    publicPath: input.publicPath,
    siteUrl: input.siteUrl,
    resolveAssetUrl: input.resolveAssetUrl,
  });
  const body = renderToStaticMarkup(
    <>
      {view.publication.snapshot.blocks.map((block) => (
        <BlockHost
          key={block.id}
          block={block}
          components={components}
          hooks={hooks}
          pageId={pageId}
          state={state}
        />
      ))}
    </>,
  );
  return {
    head,
    body,
    tags: [GLOBAL_TAG, pageTag(pageId)],
    degraded: state.degraded,
  };
}
