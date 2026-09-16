/**
 * Define-time ReDoS guard for the one user-supplied regular expression
 * surface in this phase: `short_text`'s optional `pattern` option (T-03-12).
 * A pattern is accepted only if it is at most `PATTERN_MAX_LENGTH`
 * characters, contains no backreference, never nests an unbounded
 * quantifier inside a quantified group, and compiles with the `u` flag.
 *
 * `isSafePattern` runs once, when a field is defined (`short-text.ts`'s
 * options refinement) -- never per-request against submitted values, so an
 * expensive or malicious pattern is refused before it can ever be compiled
 * against untrusted input.
 */

export const PATTERN_MAX_LENGTH = 200;

const BACKREFERENCE_PATTERN = /\\(?:[1-9]|k<)/;

type Quantifier = {
  readonly length: number;
  readonly unbounded: boolean;
};

/** Matches a quantifier (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each
 * optionally followed by a lazy `?`) starting at `index`, or `null` when
 * none is present there. `{` with no valid quantifier body is treated as a
 * literal character, matching how the regex engine itself would parse it. */
function matchQuantifierAt(pattern: string, index: number): Quantifier | null {
  const char = pattern[index];
  if (char === '*' || char === '+') {
    const lazy = pattern[index + 1] === '?';
    return { length: lazy ? 2 : 1, unbounded: true };
  }
  if (char === '?') {
    const lazy = pattern[index + 1] === '?';
    return { length: lazy ? 2 : 1, unbounded: false };
  }
  if (char === '{') {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
    if (match === null) return null;
    const hasComma = match[2] !== undefined;
    const upperBound = match[3];
    const unbounded =
      hasComma && (upperBound === undefined || upperBound === '');
    const baseLength = match[0].length;
    const lazy = pattern[index + baseLength] === '?';
    return { length: lazy ? baseLength + 1 : baseLength, unbounded };
  }
  return null;
}

type GroupFrame = {
  hasUnboundedQuantifier: boolean;
};

/**
 * A single left-to-right scan that skips escaped characters and character
 * classes, keeps a stack of open groups each recording whether it contains
 * an unbounded quantifier, and flags a pattern the moment a group closes and
 * is immediately followed by any quantifier while it contains an unbounded
 * one -- the catastrophic-backtracking shape (`(a+)+`, `(\w*)*x`).
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > PATTERN_MAX_LENGTH) return false;
  if (BACKREFERENCE_PATTERN.test(pattern)) return false;

  const stack: GroupFrame[] = [];
  let nestedUnbounded = false;
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];
    let closedFrame: GroupFrame | undefined;

    if (char === '\\') {
      index += 2;
    } else if (char === '[') {
      index += 1;
      while (index < pattern.length && pattern[index] !== ']') {
        index += pattern[index] === '\\' ? 2 : 1;
      }
      index += 1;
    } else if (char === '(') {
      stack.push({ hasUnboundedQuantifier: false });
      index += 1;
      continue;
    } else if (char === ')') {
      closedFrame = stack.pop();
      index += 1;
    } else {
      index += 1;
    }

    const quantifier = matchQuantifierAt(pattern, index);
    if (quantifier !== null) {
      if (closedFrame !== undefined && closedFrame.hasUnboundedQuantifier) {
        nestedUnbounded = true;
      }
      if (quantifier.unbounded) {
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.hasUnboundedQuantifier = true;
      }
      index += quantifier.length;
    }
  }

  if (nestedUnbounded) return false;

  try {
    // The pattern is dynamic by design (a host-configured field option) --
    // that is exactly what this function exists to make safe to compile.
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  return true;
}
