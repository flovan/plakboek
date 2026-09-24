/**
 * Define-time ReDoS guard for the one user-supplied regular expression
 * surface in this phase: `short_text`'s optional `pattern` option (T-03-12).
 * A pattern is accepted only if it is at most `PATTERN_MAX_LENGTH`
 * characters, contains no backreference, never nests a variable-width
 * quantifier (one whose minimum and maximum repeat counts differ, such as
 * `*`, `+`, `?`, `{n,}` or `{n,m}` with `m > n`, but not a fixed-width
 * `{n}`/`{n,n}`) inside a group that a following quantifier can itself
 * repeat more than once, never contains a top-level alternation inside a
 * group that a following quantifier can repeat more than once, and
 * compiles with the `u` flag.
 *
 * Group flags (`hasVariableWidthQuantifier`, `hasAlternation`) propagate
 * outward into the enclosing group the moment a group closes, so either
 * dangerous shape buried one level deeper than the group a quantifier
 * directly follows still reaches the rule that rejects it (for example
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
  /** True when one application of this quantifier can consume a different
   * number of atoms than another application can, i.e. its minimum and
   * maximum repeat counts differ (`*`, `+`, `?`, `{n,}`, `{n,m}` with
   * `m > n`). False for a fixed-width repeat (`{n}`, `{n,n}`), which
   * cannot itself create the "split a run of matches across a
   * combinatorial number of iterations" ambiguity nested-quantifier
   * catastrophic backtracking depends on, regardless of how large `n` is. */
  readonly variableWidth: boolean;
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
      variableWidth: true,
      repeatsMoreThanOnce: true,
    };
  }
  if (char === '?') {
    const lazy = pattern[index + 1] === '?';
    return {
      length: lazy ? 2 : 1,
      variableWidth: true,
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
    // `{n,m}` is variable width when its bounds differ, exactly like `?`
    // (`{0,1}`) is. `{n}` and `{n,n}` are fixed width: every application
    // consumes exactly `n` atoms, so they cannot themselves be the source
    // of a variable-width nested repeat, no matter how large `n` is.
    const variableWidth =
      unbounded || (hasComma && Number(upperBound) !== Number(match[1]));
    const baseLength = match[0].length;
    const lazy = pattern[index + baseLength] === '?';
    const repeatsMoreThanOnce = unbounded
      ? true
      : hasComma
        ? Number(upperBound) >= 2
        : Number(match[1]) >= 2;
    return {
      length: lazy ? baseLength + 1 : baseLength,
      variableWidth,
      repeatsMoreThanOnce,
    };
  }
  return null;
}

type GroupFrame = {
  /** Whether the atom immediately before this position, at THIS nesting
   * level, carried a quantifier that can repeat more than once. Two such
   * atoms side by side with nothing mandatory between them is the
   * sequential catastrophic shape (`.*.*`, `a*a*`), which is distinct from
   * the nested one (`(a+)+`) and was not modelled before. A mandatory atom
   * in between (`\d+\.\d+`) resets it, because the engine cannot then
   * redistribute a run of characters between the two. */
  previousAtomRepeatable: boolean;
  hasVariableWidthQuantifier: boolean;
  hasAlternation: boolean;
};

/**
 * A single left-to-right scan that skips escaped characters and character
 * classes, keeps a stack of open groups each recording whether it contains
 * a variable-width quantifier or a top-level alternation, propagates both
 * flags into the enclosing group when a group closes, and flags a pattern
 * the moment a group closes and is immediately followed by a quantifier
 * that can itself repeat the group more than once while (a) the group
 * holds a variable-width quantifier (`(a+)+`, `(\w*)*x`, `(a{1,2})+`,
 * `(a{2,5})*`) or (b) the group holds a top-level alternation
 * (`(a|a)*b`, `(a|a){2,}b`). Gating both rules on the outer quantifier's
 * own `repeatsMoreThanOnce` keeps an optional group safe regardless of
 * what it contains (`(a+)?`, `(v\d+\.)?\d+\.\d+`): applied at most once,
 * it cannot itself create the "multiple repeats of a repeat" ambiguity
 * either rule exists to catch.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > PATTERN_MAX_LENGTH) return false;
  if (BACKREFERENCE_PATTERN.test(pattern)) return false;

  // A root frame so the top level tracks adjacency the same way a group
  // does. It is never closed, so its own flags are never read.
  const stack: GroupFrame[] = [
    {
      hasVariableWidthQuantifier: false,
      hasAlternation: false,
      previousAtomRepeatable: false,
    },
  ];
  let nestedUnbounded = false;
  let ambiguousAlternation = false;
  let adjacentRepeatable = false;
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
      stack.push({
        hasVariableWidthQuantifier: false,
        hasAlternation: false,
        previousAtomRepeatable: false,
      });
      index += 1;
      continue;
    } else if (char === '|') {
      // A top-level bar with no open group (`a|a`) has nothing to flag --
      // `short-text.ts` wraps the whole pattern in a group it never
      // quantifies, so a bare top-level alternation is left alone.
      const innermost = stack[stack.length - 1];
      if (innermost !== undefined) {
        innermost.hasAlternation = true;
        // A branch boundary: the next atom follows nothing.
        innermost.previousAtomRepeatable = false;
      }
      index += 1;
      continue;
    } else if (char === ')') {
      closedFrame = stack.pop();
      index += 1;
      if (closedFrame !== undefined) {
        const parent = stack[stack.length - 1];
        if (parent !== undefined) {
          if (closedFrame.hasVariableWidthQuantifier) {
            parent.hasVariableWidthQuantifier = true;
          }
          if (closedFrame.hasAlternation) parent.hasAlternation = true;
        }
      }
    } else {
      index += 1;
    }

    const quantifier = matchQuantifierAt(pattern, index);
    if (quantifier !== null) {
      if (
        closedFrame !== undefined &&
        closedFrame.hasVariableWidthQuantifier &&
        quantifier.repeatsMoreThanOnce
      ) {
        nestedUnbounded = true;
      }
      if (
        closedFrame !== undefined &&
        closedFrame.hasAlternation &&
        quantifier.repeatsMoreThanOnce
      ) {
        ambiguousAlternation = true;
      }
      if (quantifier.variableWidth) {
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.hasVariableWidthQuantifier = true;
      }
      index += quantifier.length;
    }

    // Adjacency, evaluated once per atom at the level the atom sits on.
    const level = stack[stack.length - 1];
    if (level !== undefined) {
      // Restricted to non-group atoms on purpose. A quantified GROUP very
      // often opens with a mandatory separator its neighbour cannot match
      // (`[a-z0-9]+(?:-[a-z0-9]+)*`, this project's own slug pattern), which
      // leaves nothing to redistribute and is therefore safe. Deciding that
      // in general needs character-set analysis this scanner does not do, so
      // the rule stays where it is exact. See the header note on the
      // residual `(a)*(a)*` shape.
      const repeatable =
        closedFrame === undefined &&
        quantifier !== null &&
        quantifier.variableWidth &&
        quantifier.repeatsMoreThanOnce;
      if (repeatable && level.previousAtomRepeatable) {
        adjacentRepeatable = true;
      }
      level.previousAtomRepeatable = repeatable;
    }
  }

  if (nestedUnbounded || ambiguousAlternation || adjacentRepeatable) {
    return false;
  }

  try {
    // The pattern is dynamic by design (a host-configured field option) --
    // that is exactly what this function exists to make safe to compile.
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  return true;
}
