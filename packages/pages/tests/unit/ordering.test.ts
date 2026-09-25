/**
 * Sparse-integer sibling ordering arithmetic (04-06-PLAN.md Task 1) -- pure,
 * no database. Every `<behavior>` bullet the plan names for
 * `sortOrderBetween`/`needsRebalance`/`rebalancedOrders`, plus
 * `nextSortOrder`'s own append behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  needsRebalance,
  nextSortOrder,
  rebalancedOrders,
  SORT_ORDER_STEP,
  sortOrderBetween,
} from '../../src/ordering.js';

describe('SORT_ORDER_STEP', () => {
  it('is 1000', () => {
    expect(SORT_ORDER_STEP).toBe(1000);
  });
});

describe('nextSortOrder', () => {
  it('is SORT_ORDER_STEP for an empty list (null max)', () => {
    expect(nextSortOrder(null)).toBe(1000);
  });

  it('is maxExisting + SORT_ORDER_STEP for a non-empty list', () => {
    expect(nextSortOrder(1000)).toBe(2000);
    expect(nextSortOrder(4500)).toBe(5500);
  });
});

describe('sortOrderBetween', () => {
  it('is SORT_ORDER_STEP when neither neighbour is given (empty list)', () => {
    expect(sortOrderBetween(null, null)).toBe(1000);
  });

  it('is before + SORT_ORDER_STEP when only before is given', () => {
    expect(sortOrderBetween(1000, null)).toBe(2000);
  });

  it('is floor(after / 2) when only after is given', () => {
    expect(sortOrderBetween(null, 1000)).toBe(500);
  });

  it('is the floored midpoint when both are given', () => {
    expect(sortOrderBetween(1000, 2000)).toBe(1500);
  });

  it('floors an odd midpoint rather than rounding', () => {
    expect(sortOrderBetween(1000, 1003)).toBe(1001);
  });
});

describe('needsRebalance', () => {
  it('is true when the gap between two given neighbours is less than 2', () => {
    expect(needsRebalance(1000, 1001)).toBe(true);
    expect(needsRebalance(1000, 1000)).toBe(true);
  });

  it('is false when the gap between two given neighbours is 2 or more', () => {
    expect(needsRebalance(1000, 1002)).toBe(false);
    expect(needsRebalance(1000, 5000)).toBe(false);
  });

  it('is false whenever either neighbour is absent -- an end-of-list placement never rebalances', () => {
    expect(needsRebalance(null, 1000)).toBe(false);
    expect(needsRebalance(1000, null)).toBe(false);
    expect(needsRebalance(null, null)).toBe(false);
  });
});

describe('rebalancedOrders', () => {
  it('returns evenly-spaced steps of SORT_ORDER_STEP, preserving input-list order', () => {
    expect(rebalancedOrders(5)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });

  it('returns an empty array for zero siblings', () => {
    expect(rebalancedOrders(0)).toEqual([]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(rebalancedOrders(3))).toBe(true);
  });
});
