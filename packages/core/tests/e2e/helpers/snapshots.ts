/**
 * Plain, serialisable records of computed styles and bounding boxes, for
 * isolation comparisons: the same selectors measured twice, then compared
 * with `toEqual`. Works on a page or an iframe's frame.
 */
import type { Frame, Page } from '@playwright/test';

export type StyleRecord = Readonly<
  Record<string, Readonly<Record<string, string>> | null>
>;

export type BoxRecord = Readonly<
  Record<
    string,
    {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    } | null
  >
>;

/** Computed values of `properties` for the first match of each selector. */
export async function styleSnapshot(
  target: Page | Frame,
  selectors: readonly string[],
  properties: readonly string[],
): Promise<StyleRecord> {
  return await target.evaluate(
    ({ selectors: list, properties: names }) => {
      const record: Record<string, Record<string, string> | null> = {};
      for (const selector of list) {
        const element = document.querySelector(selector);
        if (element === null) {
          record[selector] = null;
          continue;
        }
        const computed = getComputedStyle(element);
        const values: Record<string, string> = {};
        for (const name of names)
          values[name] = computed.getPropertyValue(name);
        record[selector] = values;
      }
      return record;
    },
    { selectors, properties },
  );
}

/** Bounding boxes (viewport coordinates) of the first match of each selector. */
export async function boxSnapshot(
  target: Page | Frame,
  selectors: readonly string[],
): Promise<BoxRecord> {
  return await target.evaluate((list) => {
    const record: Record<
      string,
      { x: number; y: number; width: number; height: number } | null
    > = {};
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (element === null) {
        record[selector] = null;
        continue;
      }
      const { x, y, width, height } = element.getBoundingClientRect();
      record[selector] = { x, y, width, height };
    }
    return record;
  }, selectors);
}
