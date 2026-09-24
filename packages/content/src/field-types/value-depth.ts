/**
 * A structural nesting guard for the two field types that accept arbitrarily
 * shaped values, `rich_text` and `json`.
 *
 * Both hand their value to a recursive zod schema, and both had their own
 * depth checks written recursively too. A deeply nested value therefore blew
 * the JavaScript stack inside `safeParse`, which by contract never throws, so
 * a caller saw an uncaught `RangeError` instead of a validation issue. A
 * `rich_text` document only needs about 25KB to reach that point.
 *
 * The walk below is iterative, so it can measure any value without adding
 * stack frames of its own, and it stops the moment the cap is passed.
 *
 * The cap is deliberately far above anything a real document reaches and far
 * below where the engine gives out. A `rich_text` document at its own
 * `RICH_TEXT_MAX_DEPTH` of 32 content levels is roughly 65 structural levels,
 * because each level is an object holding an array holding an object.
 */
export const MAX_VALUE_NESTING_DEPTH = 200;

/**
 * True when `value` nests deeper than `max` levels of arrays and plain
 * objects. Iterative, and short-circuits on the first violation.
 */
export function exceedsNestingDepth(
  value: unknown,
  max: number = MAX_VALUE_NESTING_DEPTH,
): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const { node, depth } = current;
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return true;

    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    for (const item of Object.values(node)) {
      stack.push({ node: item, depth: depth + 1 });
    }
  }

  return false;
}
