/**
 * How the text toolbar gives up width in a narrow frame, worked out from
 * numbers alone so it is proven in Node. The bar never exceeds the frame
 * width minus 16px. Under pressure the controls collapse in a fixed order:
 * Done loses its text first; then Strikethrough, Underline, Numbered list and
 * Bulleted list move, in that order, into a More menu placed before Done. The
 * Text style button, Link and whatever else is not listed here never move.
 */

/** The controls that can be measured here (Done is measured with its text). */
export type ControlId =
  | 'style'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'bulletList'
  | 'orderedList'
  | 'link'
  | 'insert'
  | 'customStyle'
  | 'done';

/** The controls that sit in a group of the bar (Custom style and Done sit after the last divider). */
export type GroupedControlId = Exclude<ControlId, 'customStyle' | 'done'>;

/** The bar's own chrome: 1px border and 4px padding on both sides. */
export const BAR_FRAME = 10;
/** The gap between two neighbours, dividers included. */
export const BAR_GAP = 4;
export const DIVIDER_WIDTH = 1;
/** The More button. */
export const MORE_WIDTH = 32;

/** The controls in the order they are drawn, grouped as the bar groups them. */
export const CONTROL_GROUPS: readonly (readonly GroupedControlId[])[] = [
  ['style'],
  ['bold', 'italic', 'underline', 'strike'],
  ['bulletList', 'orderedList'],
  ['link'],
  ['insert'],
];

/** The order controls move into More. */
export const MOVE_ORDER = [
  'strike',
  'underline',
  'orderedList',
  'bulletList',
] as const;

export type CollapseInput = {
  /** The measured width of each control the bar shows; an absent control is not on the bar. */
  readonly widths: Readonly<Partial<Record<ControlId, number>>>;
  /** The most the bar may take: the visible frame width minus 16px. */
  readonly available: number;
  /** How much of Done's width its text is, so icon-only is that much narrower. */
  readonly doneTextWidth: number;
};

export type Collapse = {
  /** The controls left on the bar, in drawing order (Done is always shown). */
  readonly visible: readonly GroupedControlId[];
  /** The controls in the More menu, in drawing order; empty means no More button. */
  readonly inMore: readonly GroupedControlId[];
  readonly doneIconOnly: boolean;
};

function barWidth(
  input: CollapseInput,
  inMore: ReadonlySet<ControlId>,
  doneIconOnly: boolean,
): number {
  const { widths, doneTextWidth } = input;
  const children: number[] = [];
  let first = true;
  for (const group of CONTROL_GROUPS) {
    const present = group.filter(
      (id) => widths[id] !== undefined && !inMore.has(id),
    );
    if (present.length === 0) continue;
    if (!first) children.push(DIVIDER_WIDTH);
    first = false;
    for (const id of present) children.push(widths[id] ?? 0);
  }
  // A divider before Done, then Custom style (its label never collapses and
  // never moves), More when something moved, then Done.
  if (!first) children.push(DIVIDER_WIDTH);
  if (widths.customStyle !== undefined) children.push(widths.customStyle);
  if (inMore.size > 0) children.push(MORE_WIDTH);
  const done = widths.done ?? 0;
  children.push(doneIconOnly ? Math.max(0, done - doneTextWidth) : done);
  return (
    BAR_FRAME +
    children.reduce((sum, width) => sum + width, 0) +
    BAR_GAP * (children.length - 1)
  );
}

export function collapseToolbar(input: CollapseInput): Collapse {
  const moved = new Set<ControlId>();
  const result = (doneIconOnly: boolean): Collapse => {
    const drawn = CONTROL_GROUPS.flat().filter(
      (id) => input.widths[id] !== undefined,
    );
    return {
      visible: drawn.filter((id) => !moved.has(id)),
      inMore: drawn.filter((id) => moved.has(id)),
      doneIconOnly,
    };
  };
  const fits = (doneIconOnly: boolean): boolean =>
    barWidth(input, moved, doneIconOnly) <= input.available;

  if (fits(false)) return result(false);
  if (fits(true)) return result(true);
  for (const id of MOVE_ORDER) {
    if (input.widths[id] === undefined) continue;
    moved.add(id);
    if (fits(true)) break;
  }
  return result(true);
}
