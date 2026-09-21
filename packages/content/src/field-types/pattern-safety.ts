/**
 * Define-time ReDoS guard for the one user-supplied regular expression
 * surface in this phase: `short_text`'s optional `pattern` option (T-03-12).
 * A pattern is accepted only if it is at most `PATTERN_MAX_LENGTH`
 * characters, contains no backreference, never nests an unbounded
 * quantifier inside a quantified group, never contains a top-level
 * alternation inside a group that a following quantifier can repeat more
 * than once, and compiles with the `u` flag.
 *
 * Group flags (`hasUnboundedQuantifier`, `hasAlternation`) propagate outward
 * into the enclosing group the moment a group closes, so either dangerous
 * shape buried one level deeper than the group a quantifier directly
 * follows still reaches the rule that rejects it (for example
 * `((a+))*b` or `((a|a)x)*b`).
 *
 * `isSafePattern` is a definition-time gate, reached from `addField`,
 * `updateField` and the seed applier via `short-text.ts`'s options
 * refinement -- never compiled per-request against a submitted value.
 * `validateEntryData` additionally re-parses a field's *stored* options
 * through this same path on every save, so a pattern that was accepted
 * before a rule tightened is refused on the next save rather than compiled
 * against untrusted input.
 *
 * The alternation rule is deliberately conservative: it does not attempt to
 * prove the alternatives disjoint, only that a group containing any
 * top-level `|` is followed by a quantifier that can repeat that group more
 * than once. This rejects a small number of provably-safe shapes no
 * plausible `short_text` validation pattern needs, for example `(cat|dog){2}`
 * (an exact bounded repeat of a disjoint alternation) and `((cat|dog)-)+` (a
 * disjoint alternation reached through propagation). That tradeoff is
 * accepted: a regex-analysis dependency capable of proving disjointness is
 * not warranted for a single-line text pattern surface.
 */

export const PATTERN_MAX_LENGTH = 200;

const BACKREFERENCE_PATTERN = /\\(?:[1-9]|k<)/;

type Quantifier = {
  readonly length: number;
  readonly unbounded: boolean;
  readonly repeatsMoreThanOnce: boolean;
};

/** Matches a quantifier (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each
 * optionally followed by a lazy `?`) starting at `index`, or `null` when
 * none is present there. `{` with no valid quantifier body is treated as a
 * literal character, matching how the regex engine itself would parse it. */
function matchQuantifierAt(pattern: string, index: number): Quantifier | null {
  const char = pattern[index];
  if (char === '*' || char === '+') {
    const lazy = pattern[index + 1] === '?';
    return {
      length: lazy ? 2 : 1,
      unbounded: true,
      repeatsMoreThanOnce: true,
    };
  }
  if (char === '?') {
    const lazy = pattern[index + 1] === '?';
    return {
      length: lazy ? 2 : 1,
      unbounded: false,
      repeatsMoreThanOnce: false,
    };
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
    const repeatsMoreThanOnce = unbounded
      ? true
      : hasComma
        ? Number(upperBound) >= 2
        : Number(match[1]) >= 2;
    return {
      length: lazy ? baseLength + 1 : baseLength,
      unbounded,
      repeatsMoreThanOnce,
    };
  }
  return null;
}

type GroupFrame = {
  hasUnboundedQuantifier: boolean;
  hasAlternation: boolean;
};

/**
 * A single left-to-right scan that skips escaped characters and character
 * classes, keeps a stack of open groups each recording whether it contains
 * an unbounded quantifier or a top-level alternation, propagates both flags
 * into the enclosing group when a group closes, and flags a pattern the
 * moment a group closes and is immediately followed by a quantifier that
 * either (a) can repeat the group while it holds an unbounded quantifier
 * (`(a+)+`, `(\w*)*x`) or (b) can repeat the group more than once while it
 * holds a top-level alternation (`(a|a)*b`, `(a|a){2,}b`).
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > PATTERN_MAX_LENGTH) return false;
  if (BACKREFERENCE_PATTERN.test(pattern)) return false;

  const stack: GroupFrame[] = [];
  let nestedUnbounded = false;
  let ambiguousAlternation = false;
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
      stack.push({ hasUnboundedQuantifier: false, hasAlternation: false });
      index += 1;
      continue;
    } else if (char === '|') {
      // A top-level bar with no open group (`a|a`) has nothing to flag --
      // `short-text.ts` wraps the whole pattern in a group it never
      // quantifies, so a bare top-level alternation is left alone.
      const innermost = stack[stack.length - 1];
      if (innermost !== undefined) innermost.hasAlternation = true;
      index += 1;
      continue;
    } else if (char === ')') {
      closedFrame = stack.pop();
      index += 1;
      if (closedFrame !== undefined) {
        const parent = stack[stack.length - 1];
        if (parent !== undefined) {
          if (closedFrame.hasUnboundedQuantifier) {
            parent.hasUnboundedQuantifier = true;
          }
          if (closedFrame.hasAlternation) parent.hasAlternation = true;
        }
      }
    } else {
      index += 1;
    }

    const quantifier = matchQuantifierAt(pattern, index);
    if (quantifier !== null) {
      if (closedFrame !== undefined && closedFrame.hasUnboundedQuantifier) {
        nestedUnbounded = true;
      }
      if (
        closedFrame !== undefined &&
        closedFrame.hasAlternation &&
        quantifier.repeatsMoreThanOnce
      ) {
        ambiguousAlternation = true;
      }
      if (quantifier.unbounded) {
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.hasUnboundedQuantifier = true;
      }
      index += quantifier.length;
    }
  }

  if (nestedUnbounded || ambiguousAlternation) return false;

  try {
    // The pattern is dynamic by design (a host-configured field option) --
    // that is exactly what this function exists to make safe to compile.
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  return true;
}
