/**
 * The grid a host section renders around its children (D-06). The CMS adds
 * the column cells; the section's stored layout supplies the ratio and
 * alignment, and the gap comes from a theme token (D-07).
 *
 * The inline grid never needs `!important` to be overridden: tracks are read
 * through `--plakboek-columns-stack`, so a host theme stacks the columns by
 * setting that one custom property inside a container query.
 */
import {
  Children,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { BlockLayout } from './layout.js';

export type ColumnsProps = {
  /** The section's `layout` prop. */
  readonly layout: Readonly<BlockLayout>;
  /** The section's children: its column cells. */
  readonly children: ReactNode;
  readonly className?: string;
};

type GridStyle = CSSProperties & Readonly<Record<`--${string}`, string>>;

const RATIO_PATTERN = /^[1-9]\d{0,2}(?::[1-9]\d{0,2})*$/;

const EQUAL_TRACK = 'minmax(0, 1fr)';

/**
 * The `grid-template-columns` value for a ratio and a live column count. The
 * ratio is used only when it is well-formed and has exactly one term per
 * column; anything else falls back to equal tracks, so an out-of-date or
 * hand-edited ratio can never inject arbitrary CSS.
 */
export function columnTracks(ratio: string | undefined, count: number): string {
  if (ratio !== undefined && RATIO_PATTERN.test(ratio)) {
    const terms = ratio.split(':');
    if (terms.length === count) {
      return terms.map((term) => `minmax(0, ${term}fr)`).join(' ');
    }
  }
  if (count <= 1) return EQUAL_TRACK;
  return `repeat(${String(count)}, ${EQUAL_TRACK})`;
}

/** Renders the CSS grid around a section's column cells. */
export function Columns({
  layout,
  children,
  className,
}: ColumnsProps): ReactElement {
  const count = Children.count(children);
  const style: GridStyle = {
    display: 'grid',
    '--plakboek-columns-tracks': columnTracks(layout.columns, count),
    gridTemplateColumns:
      'var(--plakboek-columns-stack, var(--plakboek-columns-tracks))',
    alignItems: layout.align ?? 'stretch',
    gap: 'var(--plakboek-column-gap, 24px)',
  };
  return (
    <div
      data-plakboek-columns={String(count)}
      className={className}
      style={style}
    >
      {children}
    </div>
  );
}
