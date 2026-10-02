/**
 * Server-only React walk of a published snapshot into a head and a body.
 *
 * The body is ONE `renderToStaticMarkup` call (D-28): every block, section
 * or not, goes through the same `BlockHost` recursion (04 D-16), so no
 * branch on a block's `kind` exists here. A block's component is called as a
 * plain function, inline, so a later plan can wrap that one call in error
 * containment without touching the walk.
 */
import { GLOBAL_TAG, pageTag } from '@plakboek/cache';
import type { PublishedPageView, SnapshotBlock } from '@plakboek/pages';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOOP_EDIT } from './edit-proxy.js';
import type { ComponentMap } from './components.js';
import { buildPageHead, type PageHead } from './head.js';
import type { RenderHooks } from './hooks.js';

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

type BlockHostProps = {
  readonly block: SnapshotBlock;
  readonly components: ComponentMap;
};

function BlockHost({ block, components }: BlockHostProps): ReactNode {
  const component = components.get(block.blockType);
  if (component === undefined) return null;
  const children = block.children.map((child) => (
    <BlockHost key={child.id} block={child} components={components} />
  ));
  return component({
    block: {
      id: block.id,
      blockType: block.blockType,
      schemaVersion: block.schemaVersion,
    },
    props: block.props,
    children,
    edit: NOOP_EDIT,
  });
}

/** Renders a published page's snapshot; never touches the database. */
export function renderPageSnapshot(
  input: RenderPageSnapshotInput,
): RenderedPage {
  const { view, components } = input;
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
        <BlockHost key={block.id} block={block} components={components} />
      ))}
    </>,
  );
  return {
    head,
    body,
    tags: [GLOBAL_TAG, pageTag(view.page.id)],
    degraded: false,
  };
}
