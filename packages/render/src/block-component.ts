/**
 * The typed contract a block's `component` satisfies (D-09). `@plakboek/pages`
 * keeps `BlockDefinition.component` opaque; this package owns the shape, so a
 * host writes `component: MyBlock satisfies BlockComponent` and the renderer
 * calls it with these props.
 *
 * A `BlockComponent` is a plain function. A `memo` or `forwardRef` object is
 * not one, and the visitor handler rejects it when it is created.
 */
import type { ReactNode } from 'react';
import type { EditProxy } from './edit-proxy.js';

/** Who a rendered block is. */
export type BlockIdentity = {
  readonly id: string;
  readonly blockType: string;
  readonly schemaVersion: number;
};

/** What the renderer passes to a block component. */
export type BlockComponentProps<P = Readonly<Record<string, unknown>>> = {
  readonly block: BlockIdentity;
  readonly props: P;
  /** The block's already-rendered children, in order. */
  readonly children: ReactNode;
  /** `NOOP_EDIT` on a visitor page. */
  readonly edit: EditProxy;
};

/** A block's render function. */
export type BlockComponent<P = Readonly<Record<string, unknown>>> = (
  props: BlockComponentProps<P>,
) => ReactNode;
