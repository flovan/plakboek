/**
 * Sparse-integer sibling ordering arithmetic (RESEARCH Pattern 4, D-38's
 * assumption A1). Pure, no database: `tree.ts` calls these to derive a new
 * `sort_order` and to decide/perform a rebalance, but the step constant and
 * every arithmetic rule for it live here, and only here -- `tree.ts` never
 * re-derives a sibling order with a literal step of its own.
 *
 * `page_blocks.sort_order` is read by every later phase that orders a
 * sibling list (Phase 8's drag-and-drop, Phase 5's snapshot ordering), so
 * this module's contract -- sparse integers, steps of `SORT_ORDER_STEP`,
 * rebalanced only when a gap closes -- is a costly-to-change decision
 * (04-06-PLAN.md's own `<reversibility>` note): swapping it for a
 * lexicographic rank key later is a column-type migration plus a change at
 * every call site.
 */

/** The only place this step constant appears. A fresh sibling list's first
 * three inserts land on `1000`, `2000`, `3000`. */
export const SORT_ORDER_STEP = 1000;

/** The `sort_order` for a new last sibling, given the current maximum among
 * its siblings (`null` when the list is empty). Mirrors `insertBlock`'s
 * pre-existing default-append behaviour, now the one place that arithmetic
 * lives. */
export function nextSortOrder(maxExisting: number | null): number {
  return (maxExisting ?? 0) + SORT_ORDER_STEP;
}

/**
 * The `sort_order` for a block placed between two siblings' own orders
 * (either may be absent -- placed at an end of the list, or the list is
 * empty): the midpoint (floored) when both are given, `before +
 * SORT_ORDER_STEP` when only `before` is given (placed after the last known
 * sibling), `floor(after / 2)` when only `after` is given (placed before
 * the first known sibling), and `SORT_ORDER_STEP` when neither is given
 * (the list is empty).
 */
export function sortOrderBetween(
  before: number | null,
  after: number | null,
): number {
  if (before !== null && after !== null) {
    return Math.floor((before + after) / 2);
  }
  if (before !== null) {
    return before + SORT_ORDER_STEP;
  }
  if (after !== null) {
    return Math.floor(after / 2);
  }
  return SORT_ORDER_STEP;
}

/**
 * `true` when both neighbouring orders are given and the gap between them
 * has closed below `2` -- there is no longer an integer strictly between
 * them for `sortOrderBetween` to return. `false` whenever either neighbour
 * is absent (an end-of-list placement never needs a rebalance).
 */
export function needsRebalance(
  before: number | null,
  after: number | null,
): boolean {
  if (before === null || after === null) return false;
  return after - before < 2;
}

/**
 * The fresh, evenly-spaced `sort_order` values (`[1000, 2000, ...]`) for
 * `count` siblings, in the same order the caller's own id-stable list is
 * already in -- a rebalance assigns these positionally, never resorting
 * the list itself.
 */
export function rebalancedOrders(count: number): readonly number[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => (index + 1) * SORT_ORDER_STEP),
  );
}
