/**
 * The layout a block carries beside its declared properties (D-04, D-33):
 * how a section divides its columns and how a column's content sits. It is
 * stored on the node, not in `props`, and reaches every block component as
 * the frozen `layout` prop.
 */

/** Cross-axis alignment of the columns inside a section. */
export type ColumnAlign = 'stretch' | 'start' | 'center' | 'end';

/** A node's stored layout; every field is optional. */
export type BlockLayout = {
  /** A ratio such as `2:1`: one weight per column. */
  readonly columns?: string;
  readonly align?: ColumnAlign;
  /** Whether a block asks to fill its column's height. */
  readonly fill?: boolean;
};

const ALIGN_VALUES: readonly string[] = ['stretch', 'start', 'center', 'end'];

const EMPTY_LAYOUT: Readonly<BlockLayout> = Object.freeze({});

function isAlign(value: unknown): value is ColumnAlign {
  return typeof value === 'string' && ALIGN_VALUES.includes(value);
}

/**
 * Normalises whatever a node stores into a `BlockLayout`: only a string
 * `columns`, an `align` among the four values and a boolean `fill` survive.
 * Anything else yields one shared frozen empty object; it never throws.
 */
export function toBlockLayout(value: unknown): Readonly<BlockLayout> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return EMPTY_LAYOUT;
  }
  const columns: unknown = Reflect.get(value, 'columns');
  const align: unknown = Reflect.get(value, 'align');
  const fill: unknown = Reflect.get(value, 'fill');
  const layout: {
    columns?: string;
    align?: ColumnAlign;
    fill?: boolean;
  } = {};
  if (typeof columns === 'string') layout.columns = columns;
  if (isAlign(align)) layout.align = align;
  if (typeof fill === 'boolean') layout.fill = fill;
  return Object.keys(layout).length === 0
    ? EMPTY_LAYOUT
    : Object.freeze(layout);
}
